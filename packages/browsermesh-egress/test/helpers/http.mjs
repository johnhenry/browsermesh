/**
 * Test helpers for the fetch form: local HTTP and HTTPS origins, and a rig whose provider has the Node exchange behind the
 * simulated network. Every origin is a listener on 127.0.0.1; "public" addresses are names in a table.
 */
import http from 'node:http'
import https from 'node:https'
import { rig, PUBLIC } from './mesh.mjs'
import { CA_PEM } from './pki.mjs'
import { createExchange } from '../../src/node.mjs'

export const A1 = PUBLIC
export const A2 = '93.184.216.35'
export const A3 = '93.184.216.36'
export const PRIVATE = '10.0.0.5'

async function listen(server) {
  const sockets = new Set()
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    close() { for (const s of sockets) s.destroy(); return new Promise((resolve) => server.close(() => resolve())) },
  }
}

/** A plain HTTP origin. `handler(req, res, record)`; `seen` has what each request carried (headers as sent, the body read whole). */
export async function httpOrigin(handler) {
  const seen = []
  const server = http.createServer((req, res) => {
    const record = { method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.alloc(0) }
    seen.push(record)
    const parts = []
    req.on('data', (d) => parts.push(d))
    req.on('end', () => { record.body = Buffer.concat(parts) })
    req.on('error', () => {})
    res.on('error', () => {})
    handler(req, res, record)
  })
  server.keepAliveTimeout = 1
  return { seen, ...(await listen(server)) }
}

/** An HTTPS origin with one certificate. `servernames` collects the SNI name each client sent; `tlsErrors` the handshakes that failed. */
export async function httpsOrigin(pki, handler) {
  const seen = []
  const servernames = []
  const tlsErrors = []
  const server = https.createServer({
    cert: pki.cert, key: pki.key,
    SNICallback: (name, cb) => { servernames.push(name); cb(null, undefined) },
  }, (req, res) => {
    const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.alloc(0) }
    seen.push(record)
    const parts = []
    req.on('data', (d) => parts.push(d))
    req.on('end', () => { record.body = Buffer.concat(parts) })
    req.on('error', () => {})
    res.on('error', () => {})
    handler(req, res, record)
  })
  server.on('tlsClientError', (e) => tlsErrors.push(e.code ?? e.message))
  return { seen, servernames, tlsErrors, ...(await listen(server)) }
}

export const ok = (body = 'ok', headers = {}) => (req, res) => { res.writeHead(200, { 'content-type': 'text/plain', ...headers }); res.end(body) }

/**
 * A rig for the fetch form: the same three pods and simulated network as `rig`, with the Node exchange (trusting only the test CA)
 * as the provider's `exchange`. `names` and `origins` as `simNetwork` takes them; `grants` are the consumer's.
 */
export async function fetchRig(cleanups, { names, origins, grants = [], egress = {}, ...rest } = {}) {
  const exchange = createExchange({ ca: CA_PEM })
  return rig(cleanups, {
    names, origins, grants, ...rest,
    egress: (pods) => ({ exchange, ...(typeof egress === 'function' ? egress(pods) : egress) }),
  })
}

/** Read a Response body to the end as one Buffer. Fails the test if the end does not come in 8 s. */
export async function bodyOf(response, ms = 8000) {
  let timer
  const never = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the body did not end')), ms) })
  try { return await Promise.race([response.arrayBuffer().then((b) => Buffer.from(b)), never]) } finally { clearTimeout(timer) }
}
