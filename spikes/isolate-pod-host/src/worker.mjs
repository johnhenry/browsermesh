/**
 * worker.mjs — Worker entry for the isolate-pod-host spike (issue #185 WP2).
 *
 * Routes requests to a per-pod Durable Object (`PodObject`, one DO instance
 * per pod name, addressed via `idFromName`). The Worker itself holds no
 * pod state; it only forwards to the right DO stub.
 *
 *   POST /pods/:name/boot    → boot (idempotent) the pod named :name
 *   GET  /pods/:name/status  → { podId, kind, role, peers, booted }
 *   POST /pods/:name/send    → { to, payload } body, forwarded to pod.send()
 *   GET  /health             → { status: 'ok' } — for the test harness only
 */

export { PodObject } from './pod-object.mjs'

const ROUTE = /^\/pods\/([^/]+)\/(boot|status|send)$/

export default {
  /**
   * @param {Request} request
   * @param {{ POD: DurableObjectNamespace, RELAY_URL: string, SIGNALING_URL: string, DISCOVERY_CHANNEL: string }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ status: 'ok' })
    }

    const match = url.pathname.match(ROUTE)
    if (!match) {
      return new Response('not found', { status: 404 })
    }
    const [, name, action] = match

    if (action === 'boot' && request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 })
    }
    if (action === 'send' && request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 })
    }
    if (action === 'status' && request.method !== 'GET') {
      return new Response('method not allowed', { status: 405 })
    }

    const id = env.POD.idFromName(name)
    const stub = env.POD.get(id)

    if (action === 'boot') {
      return stub.fetch(new Request('http://pod/boot', { method: 'POST' }))
    }
    if (action === 'status') {
      return stub.fetch(new Request('http://pod/status', { method: 'GET' }))
    }
    // action === 'send'
    const body = await request.text()
    return stub.fetch(new Request('http://pod/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }))
  },
}
