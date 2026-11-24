import net from 'node:net'
import { createMeshIngress, serveHttpOnMesh } from '../../src/index.mjs'
import { listenNode } from '../../src/node.mjs'
import { threePods, grantHttp } from './mesh.mjs'

/**
 * A provider on one pod, an ingress on another, a real listener on loopback. `resolve` defaults to
 * "the Host app.test is the provider".
 */
export async function httpRig({ handler = () => new Response('hello'), ingress = {}, listen = {}, provider = {} } = {}, cleanups) {
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  const served = serveHttpOnMesh(pods.p, handler, { allowFrom: [pods.ingress.podId], ...provider })
  cleanups.push(() => served.stop())
  grantHttp(pods)
  const audits = []
  const mesh = createMeshIngress({
    service: pods.i,
    // `fetch` cannot choose its Host, so the loopback address is mapped too; `raw` can name any host.
    resolve: (request) => { const h = new URL(request.url).host; return h === 'app.test' || h.startsWith('127.0.0.1:') ? { peer: pods.provider.podId } : null },
    onAudit: (r) => audits.push(r),
    ...ingress,
  })
  cleanups.push(() => mesh.close())
  const listener = await listenNode(mesh, { port: 0, ...listen })
  cleanups.push(() => listener.close())
  const base = `http://127.0.0.1:${listener.port}`
  return {
    ...pods, mesh, served, listener, audits, base,
    /** A real HTTP request through the listener (Host is the loopback address: fetch does not let a caller set it). */
    fetch: (path = '/', init = {}) => fetch(`${base}${path}`, init),
    raw: (text, opts) => raw(listener.port, text, opts),
  }
}

/**
 * Send bytes on a fresh socket and collect everything the server writes until it closes (or `until(buffer)` is
 * true, or the peer ends). Returns `{ text, closed }`.
 */
export function raw(port, text, { until, keepOpen = false, parts } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let buffer = ''
    let done = false
    const finish = (closed) => { if (done) return; done = true; if (!keepOpen) socket.destroy(); resolve({ text: buffer, closed, socket }) }
    socket.setEncoding('latin1')
    socket.on('data', (d) => { buffer += d; if (until?.(buffer)) finish(false) })
    socket.on('close', () => finish(true))
    socket.on('error', (e) => { if (e.code === 'ECONNRESET' || e.code === 'EPIPE') finish(true); else reject(e) })
    socket.on('connect', async () => {
      if (parts) { for (const p of parts) { socket.write(p); await new Promise((r) => setTimeout(r, 5)) } } else socket.write(text)
    })
  })
}

export const statusOf = (response) => Number(/^HTTP\/1\.\d (\d{3})/.exec(response)?.[1] ?? 0)
export const completeResponse = (text) => /\r\n\r\n/.test(text)
