/**
 * worker-websocket.mjs — outbound (client-role) WebSocket for workerd.
 *
 * `@johnhenry/browsermesh-pod`'s `WebSocketTransport` is written against the browser/Node `WebSocket`
 * constructor shape: `new WebSocket(url)`, then `addEventListener('open'|
 * 'message'|'close'|'error', ...)`, `.send()`, `.close()`, `.readyState`.
 *
 * workerd does NOT support `new WebSocket(url)` as an outbound client
 * constructor. The documented way for a Worker/Durable Object to connect
 * OUT to a remote WebSocket server is the fetch-with-Upgrade-header dance
 * (https://developers.cloudflare.com/workers/examples/websockets/):
 *
 *   const resp = await fetch(url, { headers: { Upgrade: 'websocket' } })
 *   const ws = resp.webSocket
 *   ws.accept()
 *
 * This class wraps that dance behind the `new WS(url)` shape WebSocketTransport
 * expects, so the transport itself stays environment-agnostic (same file
 * works against Node's global WebSocket and this adapter, just injected
 * differently). It buffers `send()` calls made before the upgrade
 * completes and replays them once the socket is open, and maps the
 * workerd WebSocket's events onto plain DOM-style Event/MessageEvent/
 * CloseEvent dispatches so `addEventListener` callers see the shape they
 * expect.
 *
 * IMPORTANT — this is also why WebSocket Hibernation does not apply here:
 * hibernation is only for WebSockets the Durable Object *accepts* as a
 * server (via `ctx.acceptWebSocket()` on a `WebSocketPair`). The connection
 * this class opens is the DO acting as a *client* reaching out to the relay
 * / signaling servers; the Hibernation API does not cover outbound
 * connections, and (per Cloudflare's docs) an open outbound WebSocket keeps
 * the Durable Object pinned in memory rather than letting it hibernate. See
 * the README "What wasn't achievable" section for the full explanation.
 */

export class WorkerClientWebSocket extends EventTarget {
  /** @type {WebSocket|null} */
  #ws = null
  /** @type {Array<string|ArrayBuffer|ArrayBufferView>} */
  #sendQueue = []
  #closed = false

  /** @param {string} url */
  constructor(url) {
    super()
    this.url = url
    this.readyState = 0 // CONNECTING
    this.#connect(url)
  }

  async #connect(url) {
    try {
      // fetch() requires an http(s) scheme even for the Upgrade-header
      // WebSocket dance — ws(s):// is rejected outright. WebSocketTransport
      // and env vars use ws(s):// (correct for a real WebSocket
      // constructor, e.g. Node's global WebSocket), so translate here.
      const httpUrl = url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
      const resp = await fetch(httpUrl, { headers: { Upgrade: 'websocket' } })
      const ws = resp.webSocket
      if (!ws) {
        throw new Error(`server at ${url} didn't accept WebSocket upgrade (status ${resp.status})`)
      }
      ws.accept()
      this.#ws = ws
      this.readyState = 1 // OPEN

      ws.addEventListener('message', (event) => {
        this.dispatchEvent(new MessageEvent('message', { data: event.data }))
      })
      ws.addEventListener('close', (event) => {
        this.readyState = 3 // CLOSED
        this.#closed = true
        this.dispatchEvent(new CloseEvent('close', {
          code: event.code, reason: event.reason, wasClean: event.wasClean,
        }))
      })
      ws.addEventListener('error', () => {
        this.dispatchEvent(new Event('error'))
      })

      for (const payload of this.#sendQueue.splice(0)) {
        ws.send(payload)
      }
      this.dispatchEvent(new Event('open'))
    } catch (err) {
      this.readyState = 3 // CLOSED
      this.#closed = true
      this.dispatchEvent(new Event('error'))
      this.dispatchEvent(new CloseEvent('close', { code: 1006, reason: String(err && err.message || err) }))
    }
  }

  /** @param {string|ArrayBuffer|ArrayBufferView} data */
  send(data) {
    if (this.#closed) return
    if (this.#ws && this.readyState === 1) {
      this.#ws.send(data)
    } else {
      this.#sendQueue.push(data)
    }
  }

  close(code, reason) {
    this.#closed = true
    this.readyState = 2 // CLOSING
    if (this.#ws) {
      try { this.#ws.close(code, reason) } catch { /* ignore */ }
    } else {
      this.readyState = 3
    }
  }
}
