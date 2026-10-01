/**
 * fake-websocket.mjs — in-process WebSocket + relay/signaling server fakes
 * for testing WebSocketTransport without a real network.
 *
 * `createFakeWebSocketNetwork()` returns a `FakeWebSocket` constructor
 * (same shape as the standard WebSocket: `addEventListener`, `send`,
 * `close`, `readyState`) plus factories for fake relay and signaling
 * servers that implement the same message semantics as
 * `browsermesh-servers/relay/index.mjs` and `browsermesh-servers/signaling/index.mjs`
 * (register/registered, relay{target,envelope}/relayed{source,envelope},
 * signal{target,...}/{...,source}, peers/peer-joined/peer-left, ping/pong,
 * error) — just entirely in-process, over microtasks instead of real sockets.
 *
 * Each call returns an isolated network (its own url->server registry) so
 * tests don't leak state into one another.
 */

const OPEN = 1
const CLOSED = 3

class FakeEventTarget {
  #listeners = new Map()

  addEventListener(type, fn) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set())
    this.#listeners.get(type).add(fn)
  }

  removeEventListener(type, fn) {
    this.#listeners.get(type)?.delete(fn)
  }

  _dispatch(type, detail) {
    for (const fn of this.#listeners.get(type) ?? []) {
      try { fn(detail) } catch { /* listener errors don't crash the fake */ }
    }
  }
}

// ---------------------------------------------------------------------------
// FakeRelayServer — mirrors browsermesh-servers/relay/index.mjs semantics
// ---------------------------------------------------------------------------

export class FakeRelayServer {
  #clients = new Map() // podId -> FakeWebSocket
  #log = []
  connectionCount = 0

  connect(ws) {
    this.connectionCount++
  }

  disconnect(ws) {
    if (ws.podId) this.#clients.delete(ws.podId)
  }

  receive(ws, data) {
    if (!ws.podId) {
      if (data.type !== 'register' || !data.podId) {
        ws._serverSend({ type: 'error', message: 'first message must be { type: "register", podId: string }' })
        return
      }
      if (this.#clients.has(data.podId)) {
        ws._serverSend({ type: 'error', message: 'podId already registered' })
        ws._serverClose()
        return
      }
      ws.podId = data.podId
      this.#clients.set(data.podId, ws)
      ws._serverSend({ type: 'registered', podId: data.podId })
      return
    }

    this.#log.push({ podId: ws.podId, data })

    if (data.type === 'relay') {
      const { target, envelope } = data
      if (typeof target !== 'string' || !target) {
        ws._serverSend({ type: 'error', message: 'relay messages require a "target" field' })
        return
      }
      const targetWs = this.#clients.get(target)
      if (!targetWs) {
        ws._serverSend({ type: 'error', message: `peer "${target}" not found` })
        return
      }
      targetWs._serverSend({ type: 'relayed', source: ws.podId, envelope })
      return
    }

    if (data.type === 'ping') {
      ws._serverSend({ type: 'pong', timestamp: Date.now() })
      return
    }

    ws._serverSend({ type: 'error', message: `unknown message type: ${data.type}` })
  }

  /** Force-drop a registered client's connection, as if the network died. */
  kill(podId) {
    const ws = this.#clients.get(podId)
    if (ws) ws._serverClose()
  }

  /** Push an arbitrary frame directly to a registered client (test hook). */
  pushTo(podId, data) {
    const ws = this.#clients.get(podId)
    if (ws) ws._serverSend(data)
  }

  get log() { return [...this.#log] }
  get size() { return this.#clients.size }
}

// ---------------------------------------------------------------------------
// FakeSignalingServer — mirrors browsermesh-servers/signaling/index.mjs semantics
// ---------------------------------------------------------------------------

export class FakeSignalingServer {
  #clients = new Map() // podId -> FakeWebSocket
  #log = []
  connectionCount = 0

  connect(ws) {
    this.connectionCount++
  }

  disconnect(ws) {
    if (ws.podId) {
      this.#clients.delete(ws.podId)
      this.#broadcast({ type: 'peer-left', podId: ws.podId })
    }
  }

  receive(ws, data) {
    if (!ws.podId) {
      if (data.type !== 'register' || !data.podId) {
        ws._serverSend({ type: 'error', message: 'first message must be { type: "register", podId: string }' })
        return
      }
      if (this.#clients.has(data.podId)) {
        ws._serverSend({ type: 'error', message: 'podId already registered' })
        ws._serverClose()
        return
      }
      ws.podId = data.podId
      this.#clients.set(data.podId, ws)
      ws._serverSend({ type: 'registered', podId: data.podId })
      ws._serverSend({ type: 'peers', peers: [...this.#clients.keys()] })
      this.#broadcastExcept(ws, { type: 'peer-joined', podId: data.podId })
      return
    }

    this.#log.push({ podId: ws.podId, data })

    if (data.type === 'signal') {
      const { target, ...payload } = data
      if (typeof target !== 'string' || !target) {
        ws._serverSend({ type: 'error', message: 'forwarded messages require a "target" field' })
        return
      }
      const targetWs = this.#clients.get(target)
      if (!targetWs) {
        ws._serverSend({ type: 'error', message: `peer "${target}" not found` })
        return
      }
      targetWs._serverSend({ ...payload, source: ws.podId })
      return
    }

    if (data.type === 'ping') {
      ws._serverSend({ type: 'pong', timestamp: Date.now() })
      return
    }

    ws._serverSend({ type: 'error', message: `unknown message type: ${data.type}` })
  }

  /** Push an arbitrary frame directly to a registered client (test hook). */
  pushTo(podId, data) {
    const ws = this.#clients.get(podId)
    if (ws) ws._serverSend(data)
  }

  #broadcast(data) {
    for (const ws of this.#clients.values()) ws._serverSend(data)
  }

  #broadcastExcept(exclude, data) {
    for (const ws of this.#clients.values()) {
      if (ws !== exclude) ws._serverSend(data)
    }
  }

  get log() { return [...this.#log] }
  get size() { return this.#clients.size }
}

// ---------------------------------------------------------------------------
// Network factory
// ---------------------------------------------------------------------------

/**
 * @returns {{
 *   FakeWebSocket: new (url: string) => any,
 *   registerServer: (url: string, server: FakeRelayServer|FakeSignalingServer) => void,
 *   createRelayServer: () => FakeRelayServer,
 *   createSignalingServer: () => FakeSignalingServer,
 * }}
 */
export function createFakeWebSocketNetwork() {
  const registry = new Map()

  class FakeWebSocket extends FakeEventTarget {
    constructor(url) {
      super()
      this.url = url
      this.readyState = 0 // CONNECTING
      this.podId = null
      const server = registry.get(url)
      if (!server) throw new Error(`FakeWebSocket: no server registered for url "${url}"`)
      this._server = server
      queueMicrotask(() => this._open())
    }

    _open() {
      if (this.readyState !== 0) return
      this.readyState = OPEN
      this._server.connect(this)
      this._dispatch('open', {})
    }

    send(raw) {
      if (this.readyState !== OPEN) return
      let data
      try { data = JSON.parse(raw) } catch { return }
      queueMicrotask(() => {
        if (this.readyState !== OPEN) return
        this._server.receive(this, data)
      })
    }

    _serverSend(data) {
      if (this.readyState !== OPEN) return
      queueMicrotask(() => {
        if (this.readyState !== OPEN) return
        this._dispatch('message', { data: JSON.stringify(data) })
      })
    }

    _serverClose() {
      this.close()
    }

    close() {
      if (this.readyState === CLOSED) return
      this.readyState = CLOSED
      this._server.disconnect(this)
      this._dispatch('close', {})
    }
  }

  return {
    FakeWebSocket,
    registerServer: (url, server) => registry.set(url, server),
    createRelayServer: () => new FakeRelayServer(),
    createSignalingServer: () => new FakeSignalingServer(),
  }
}
