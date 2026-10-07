/**
 * static-server.mjs — a tiny `node:http` static file server for the e2e
 * test, serving `static/pod.html` plus the two source trees it needs to
 * resolve as real browser ES modules: `@johnhenry/browsermesh-pod`'s
 * `src/` (at `/pod/`) and `@johnhenry/browsermesh-primitives`'s `src/`
 * (at `/primitives/`, matching `pod.html`'s import map).
 *
 * `file://` URLs do not work for cross-module ES imports in headless
 * Chrome (CORS blocks `fetch`-based module resolution across `file://`
 * origins), so real HTTP it is — test-only infrastructure, not something
 * either package needs to ship.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const STATIC_DIR = join(HERE, '..', 'static')
const POD_SRC_DIR = join(HERE, '..', '..', '..', 'packages', 'browsermesh-pod', 'src')
const PRIMITIVES_SRC_DIR = join(HERE, '..', '..', '..', 'packages', 'browsermesh-primitives', 'src')

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
})

/**
 * @param {string} urlPath
 * @returns {string|null} An absolute file path, or null if out of bounds / unknown prefix.
 */
function resolveFile(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '')
  if (clean === '/' || clean === '/pod.html') return join(STATIC_DIR, 'pod.html')
  if (clean.startsWith('/pod/')) return join(POD_SRC_DIR, clean.slice('/pod/'.length))
  if (clean.startsWith('/primitives/')) return join(PRIMITIVES_SRC_DIR, clean.slice('/primitives/'.length))
  return null
}

/**
 * Start the static server on an OS-assigned port.
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>}>}
 */
export async function startStaticServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const filePath = resolveFile(url.pathname)
      if (!filePath || !existsSync(filePath)) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      const body = await readFile(filePath)
      const type = MIME[extname(filePath)] || 'application/octet-stream'
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    } catch (err) {
      console.error('[static-server]', err)
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('internal error')
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
