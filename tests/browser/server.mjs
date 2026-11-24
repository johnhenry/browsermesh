/**
 * Static server + local relay/signalling for the real-browser tests.
 *
 * No dependencies: `node:http` and a minimal RFC 6455 WebSocket server.
 *
 * What it serves
 *   /                         the harness page (import map injected)
 *   /pkg/<dir>/...            files under packages/<dir>/src (plain ES modules, no bundler)
 *   /harness/...              files under tests/browser/harness
 *   /examples/...             the repository's examples/ (run unmodified in a page)
 *   /relay, /signaling, /echo WebSocket endpoints (see below)
 *
 * Every response carries a strict Content-Security-Policy WITHOUT
 * `unsafe-eval` (and without `wasm-unsafe-eval` and `unsafe-inline`), plus
 * COOP/COEP, so the tests also prove the packages run under such a policy.
 * The inline import map is allowed by a per-response nonce.
 *
 * The relay and signalling endpoints speak the browsermesh-servers wire
 * protocol that `WebSocketTransport` (browsermesh-pod) implements: the real
 * servers live in the sibling repository johnhenry/browsermesh-servers, so
 * this is an in-repo test double, the same role the fake servers in
 * examples/12 play, but over a real socket:
 *   register   {type:'register', podId}            -> {type:'registered', podId}
 *   relay      {type:'relay', target, envelope}    -> target gets {type:'relayed', source, envelope}
 *   signal     {type:'signal', target, envelope}   -> target gets {type:'signal', source, envelope}
 *   signalling also sends {type:'peers', peers} on register and
 *   {type:'peer-joined'|'peer-left', podId} to the others.
 * `/echo` echoes every text or binary message back.
 */

import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const PACKAGES = path.join(REPO, 'packages')
const HARNESS = path.join(HERE, 'harness')
const WSH_SRC = path.join(REPO, 'node_modules', '@johnhenry', 'wsh', 'src')

const MIME = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
}

/** Largest WebSocket message the test double accepts (the tests send 1 MiB). */
const MAX_WS_MESSAGE = 8 * 1024 * 1024

/**
 * Bare specifier -> URL for every workspace package, from its package.json
 * `exports["."]` (or `main`). Third-party dependencies are not needed: the
 * packages under test import none eagerly.
 */
export async function buildImportMap() {
  const imports = {}
  for (const dir of await readdir(PACKAGES)) {
    let pkg
    try {
      pkg = JSON.parse(await readFile(path.join(PACKAGES, dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const dot = pkg.exports?.['.']
    const entry = typeof dot === 'string' ? dot : dot?.import ?? pkg.main
    if (!pkg.name || !entry) continue
    imports[pkg.name] = `/pkg/${dir}/${entry.replace(/^\.\//, '')}`
  }
  // The examples are written for Node and import `node:assert/strict`.
  imports['node:assert/strict'] = '/harness/assert-shim.mjs'
  // The one third-party dependency a package under test needs in the page: wsh's browser-safe page entry
  // (the WebMCP bridge), served from the installed package's source, nothing else of it.
  imports['@johnhenry/wsh/page'] = '/vendor/wsh/page-host.mjs'
  return { imports }
}

/**
 * A page can be framed, or frame others, only when its URL asks for it
 * (`?frame-ancestors=<origin>`, `?frame-src=<origin>,<origin>`); the values
 * must be exact loopback origins of this test double. Every other page keeps
 * `frame-ancestors 'none'` and no `frame-src` (so `default-src 'none'` blocks frames).
 */
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d+$/
export function framing(search = '') {
  const params = new URLSearchParams(search)
  const origins = (name) => (params.get(name) ?? '').split(',').filter((o) => LOOPBACK_ORIGIN.test(o))
  return { ancestors: origins('frame-ancestors'), src: origins('frame-src') }
}

export const CSP = (nonce, { ancestors = [], src = [] } = {}) => [
  "default-src 'none'",
  `script-src 'self' 'nonce-${nonce}'`,
  "connect-src 'self'",
  "style-src 'none'",
  "img-src data:", // the page declares an empty data: favicon so browsers do not request /favicon.ico
  "base-uri 'none'",
  "form-action 'none'",
  ...(src.length ? [`frame-src ${src.join(' ')}`] : []),
  `frame-ancestors ${ancestors.length ? ancestors.join(' ') : "'none'"}`,
].join('; ')

function securityHeaders(nonce, frames = {}) {
  return {
    'Content-Security-Policy': CSP(nonce, frames),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    // A page that may be framed by another origin has to say it can be loaded there.
    'Cross-Origin-Resource-Policy': frames.ancestors?.length ? 'cross-origin' : 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  }
}

// ---------------------------------------------------------------------------
// Minimal WebSocket server (RFC 6455): text/binary data, ping/pong, close.
// ---------------------------------------------------------------------------

class WsConnection {
  #socket
  #buffer = Buffer.alloc(0)
  #fragments = []
  #fragmentOpcode = 0
  onmessage = null
  onclose = null
  closed = false

  constructor(socket) {
    this.#socket = socket
    socket.on('data', (chunk) => this.#onData(chunk))
    socket.on('close', () => this.#finish())
    socket.on('error', () => this.#finish())
  }

  #finish() {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    for (;;) {
      const buf = this.#buffer
      if (buf.length < 2) return
      const fin = (buf[0] & 0x80) !== 0
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let length = buf[1] & 0x7f
      let offset = 2
      if (length === 126) {
        if (buf.length < 4) return
        length = buf.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buf.length < 10) return
        length = Number(buf.readBigUInt64BE(2))
        offset = 10
      }
      if (!masked || length > MAX_WS_MESSAGE) return this.#fail(1002)
      if (buf.length < offset + 4 + length) return
      const mask = buf.subarray(offset, offset + 4)
      const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + length))
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      this.#buffer = buf.subarray(offset + 4 + length)
      this.#frame(fin, opcode, payload)
      if (this.closed) return
    }
  }

  #frame(fin, opcode, payload) {
    if (opcode === 0x8) { // close
      this.#write(0x8, payload.subarray(0, 2))
      this.#socket.end()
      return
    }
    if (opcode === 0x9) return this.#write(0xa, payload) // ping -> pong
    if (opcode === 0xa) return
    if (opcode !== 0) { this.#fragmentOpcode = opcode; this.#fragments = [] }
    this.#fragments.push(payload)
    if (!fin) return
    const data = Buffer.concat(this.#fragments)
    const kind = this.#fragmentOpcode
    this.#fragments = []
    if (kind === 0x1) this.onmessage?.(data.toString('utf8'), false)
    else if (kind === 0x2) this.onmessage?.(data, true)
  }

  #fail(code) {
    const body = Buffer.alloc(2)
    body.writeUInt16BE(code)
    this.#write(0x8, body)
    this.#socket.end()
  }

  #write(opcode, payload) {
    if (this.closed || this.#socket.destroyed) return
    let header
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length])
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    this.#socket.write(Buffer.concat([header, payload]))
  }

  send(data) {
    if (typeof data === 'string') this.#write(0x1, Buffer.from(data, 'utf8'))
    else this.#write(0x2, data)
  }

  close() { this.#socket.end() }
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function acceptUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key']
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
    socket.destroy()
    return null
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'))
  return new WsConnection(socket)
}

// ---------------------------------------------------------------------------
// Relay / signalling hub, shared by every server instance (so two origins on
// two ports still reach one rendezvous point, like two sites using one relay).
// ---------------------------------------------------------------------------

export class Hub {
  /** @type {Map<string, Map<string, WsConnection>>} endpoint -> podId -> connection */
  #rooms = new Map([['/relay', new Map()], ['/signaling', new Map()]])

  /**
   * A test double for a malicious signalling server: the podId of a client that is handed every
   * `signal` frame addressed to anyone else (wrapped as `{ mitm: { from, to }, ...envelope }`).
   * Frames sent by that client are routed normally. `null` (default) is an honest server.
   * @type {string|null}
   */
  intercept = null

  attach(endpoint, conn) {
    const room = this.#rooms.get(endpoint)
    let podId = null
    const reply = (obj) => conn.send(JSON.stringify(obj))
    conn.onmessage = (raw, binary) => {
      if (binary) return
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (!msg || typeof msg !== 'object') return
      if (podId === null) {
        if (msg.type !== 'register' || typeof msg.podId !== 'string' || !msg.podId) return
        podId = msg.podId
        room.get(podId)?.close() // a re-registration replaces the old connection
        room.set(podId, conn)
        // Same order as the real server: `registered`, then `peers`.
        reply({ type: 'registered', podId })
        if (endpoint === '/signaling') {
          reply({ type: 'peers', peers: [...room.keys()] })
          for (const [id, peer] of room) {
            if (id !== podId) peer.send(JSON.stringify({ type: 'peer-joined', podId }))
          }
        }
        return
      }
      if (msg.type === 'ping') return reply({ type: 'pong' })
      const forwarded = endpoint === '/relay' ? 'relay' : 'signal'
      if (msg.type === forwarded) {
        if (this.intercept && endpoint === '/signaling' && podId !== this.intercept && msg.target !== this.intercept) {
          const attacker = room.get(this.intercept)
          if (attacker) {
            attacker.send(JSON.stringify({ type: 'signal', source: podId, envelope: { mitm: { from: podId, to: msg.target }, ...msg.envelope } }))
            return
          }
        }
        const target = room.get(msg.target)
        if (!target) return reply({ type: 'error', message: `peer "${msg.target}" not found` })
        target.send(JSON.stringify({
          type: endpoint === '/relay' ? 'relayed' : 'signal',
          source: podId,
          envelope: msg.envelope,
        }))
      }
    }
    conn.onclose = () => {
      if (podId === null || room.get(podId) !== conn) return
      room.delete(podId)
      if (endpoint === '/signaling') {
        for (const peer of room.values()) peer.send(JSON.stringify({ type: 'peer-left', podId }))
      }
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function sendFile(res, nonce, root, relative) {
  const full = path.resolve(root, relative)
  const ext = path.extname(full)
  // Stay inside the root, and serve only module/JSON source.
  if ((full !== root && !full.startsWith(root + path.sep)) || !MIME[ext] || ext === '.html') {
    res.writeHead(404, securityHeaders(nonce)).end('not found')
    return
  }
  try {
    const body = await readFile(full)
    res.writeHead(200, { ...securityHeaders(nonce), 'Content-Type': MIME[ext] }).end(body)
  } catch {
    res.writeHead(404, securityHeaders(nonce)).end('not found')
  }
}

/**
 * @param {object} [opts]
 * @param {number} [opts.port=0] - 0 picks a free port
 * @param {Hub} [opts.hub] - share one hub between servers (two origins, one relay)
 * @returns {Promise<{port: number, origin: string, hub: Hub, close: () => Promise<void>}>}
 */
export async function startServer({ port = 0, hub = new Hub() } = {}) {
  const importMap = await buildImportMap()
  const sockets = new Set()

  const server = http.createServer(async (req, res) => {
    const nonce = randomBytes(16).toString('base64')
    const url = new URL(req.url, 'http://localhost')
    const pathname = decodeURIComponent(url.pathname)

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res.writeHead(405, securityHeaders(nonce)).end('method not allowed')
    }
    if (pathname === '/' || pathname === '/index.html') {
      const html = (await readFile(path.join(HARNESS, 'index.html'), 'utf8'))
        .replaceAll('{{NONCE}}', nonce)
        .replace('{{IMPORT_MAP}}', JSON.stringify(importMap))
      return res.writeHead(200, { ...securityHeaders(nonce, framing(url.search)), 'Content-Type': MIME['.html'] }).end(html)
    }
    if (pathname.startsWith('/pkg/')) {
      const [, , dir, ...rest] = pathname.split('/')
      if (!dir || dir === 'node_modules') return res.writeHead(404, securityHeaders(nonce)).end('not found')
      return sendFile(res, nonce, path.join(PACKAGES, dir, 'src'), rest.join('/').replace(/^src\//, ''))
    }
    if (pathname.startsWith('/vendor/wsh/')) {
      return sendFile(res, nonce, WSH_SRC, pathname.slice('/vendor/wsh/'.length))
    }
    if (pathname.startsWith('/examples/')) {
      return sendFile(res, nonce, path.join(REPO, 'examples'), pathname.slice('/examples/'.length))
    }
    if (pathname.startsWith('/harness/')) {
      return sendFile(res, nonce, HARNESS, pathname.slice('/harness/'.length))
    }
    res.writeHead(404, securityHeaders(nonce)).end('not found')
  })

  server.on('upgrade', (req, socket) => {
    const endpoint = new URL(req.url, 'http://localhost').pathname
    if (endpoint !== '/relay' && endpoint !== '/signaling' && endpoint !== '/echo') return socket.destroy()
    // A WebSocket handshake is not covered by the same-origin policy, so the
    // server checks the Origin itself: only pages this server served.
    const origin = req.headers.origin
    if (origin !== `http://${req.headers.host}`) return socket.destroy()
    const conn = acceptUpgrade(req, socket)
    if (!conn) return
    if (endpoint === '/echo') conn.onmessage = (data) => conn.send(data)
    else hub.attach(endpoint, conn)
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const actual = server.address().port
  return {
    port: actual,
    origin: `http://127.0.0.1:${actual}`,
    hub,
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy()
      server.close(() => resolve())
    }),
  }
}

// `node tests/browser/server.mjs [port]` runs a server by hand, for debugging a page.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startServer({ port: Number(process.argv[2] ?? 0) })
  console.log(`harness at ${s.origin}/`)
}
