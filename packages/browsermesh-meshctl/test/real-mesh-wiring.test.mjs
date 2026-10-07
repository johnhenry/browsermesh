/**
 * real-mesh-wiring.test.mjs — the `--signaling` path's own doc comment
 * (`src/real-mesh.mjs`) says plainly: this was NOT exercised end to end
 * (that needs `node-datachannel`'s native WebRTC binding). What IS tested
 * here, against a FAKE in-process signaling transport (same shape
 * `examples/12-hosted-pod-over-websocket.mjs` uses to stand in for a real
 * `browsermesh-servers/signaling` server): that `createRealMeshSession()`
 * builds a `PeerNode` carrying the PERSISTED identity's podId (not a fresh
 * one -- the whole reason this module doesn't just call `createMeshNode()`
 * directly, see its header), that the signaling transport actually opens
 * and registers, that `--relay` opens its own second transport, and that
 * the full `main()` chain (`--signaling` -> `connect.mjs` -> `commands.
 * mjs`) wires together without hanging even though nothing answers.
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRealMeshSession } from '../src/real-mesh.mjs'
import { buildTestIdentity, runCli } from './helpers.mjs'

const OPEN = 1
const CLOSED = 3

class FakeEventTarget {
  #listeners = new Map()
  addEventListener(type, fn) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set())
    this.#listeners.get(type).add(fn)
  }
  removeEventListener(type, fn) { this.#listeners.get(type)?.delete(fn) }
  _dispatch(type, detail) {
    for (const fn of this.#listeners.get(type) ?? []) fn(detail)
  }
}

/** A fake signaling server: register/peers/peer-joined/peer-left, same wire shape `ws-transport.mjs` documents. */
class FakeSignalingServer {
  #clients = new Map()
  connect() {}
  disconnect(ws) {
    if (ws.podId) {
      this.#clients.delete(ws.podId)
      for (const peer of this.#clients.values()) peer._serverSend({ type: 'peer-left', podId: ws.podId })
    }
  }
  receive(ws, data) {
    if (!ws.podId) {
      if (data.type !== 'register' || !data.podId) return
      ws.podId = data.podId
      this.#clients.set(data.podId, ws)
      ws._serverSend({ type: 'registered', podId: data.podId })
      ws._serverSend({ type: 'peers', peers: [...this.#clients.keys()] })
      for (const peer of this.#clients.values()) {
        if (peer !== ws) peer._serverSend({ type: 'peer-joined', podId: data.podId })
      }
      return
    }
    if (data.type === 'signal') {
      const target = this.#clients.get(data.target)
      if (target) target._serverSend({ type: 'signal', source: ws.podId, envelope: data.envelope })
    }
  }
}

/** A fake relay server: register/relay/relayed, same wire shape `ws-transport.mjs` documents. */
class FakeRelayServer {
  #clients = new Map()
  connect() {}
  disconnect(ws) { if (ws.podId) this.#clients.delete(ws.podId) }
  receive(ws, data) {
    if (!ws.podId) {
      if (data.type !== 'register' || !data.podId) return
      ws.podId = data.podId
      this.#clients.set(data.podId, ws)
      ws._serverSend({ type: 'registered', podId: data.podId })
      return
    }
    if (data.type === 'relay') {
      const target = this.#clients.get(data.target)
      if (target) target._serverSend({ type: 'relayed', source: ws.podId, envelope: data.envelope })
    }
  }
}

function createFakeNetwork() {
  const registry = new Map()
  class FakeWebSocket extends FakeEventTarget {
    constructor(url) {
      super()
      this.url = url
      this.readyState = 0
      this.podId = null
      this._server = registry.get(url)
      queueMicrotask(() => {
        this.readyState = OPEN
        this._server.connect(this)
        this._dispatch('open', {})
      })
    }
    send(raw) {
      if (this.readyState !== OPEN) return
      const data = JSON.parse(raw)
      queueMicrotask(() => this.readyState === OPEN && this._server.receive(this, data))
    }
    _serverSend(data) {
      if (this.readyState !== OPEN) return
      queueMicrotask(() => this.readyState === OPEN && this._dispatch('message', { data: JSON.stringify(data) }))
    }
    close() {
      if (this.readyState === CLOSED) return
      this.readyState = CLOSED
      this._server.disconnect(this)
      this._dispatch('close', {})
    }
  }
  return { FakeWebSocket, registerServer: (url, server) => registry.set(url, server) }
}

describe('real-mesh wiring (fake signaling transport)', () => {
  /** @type {Array<() => Promise<void>>} */
  const cleanups = []
  after(async () => { for (const fn of cleanups.reverse()) await fn() })

  it('builds a PeerNode carrying the PERSISTED identity podId, not a freshly-minted one', async () => {
    const net = createFakeNetwork()
    net.registerServer('ws://signaling.local/', new FakeSignalingServer())
    const { cliIdentity, cleanup } = await buildTestIdentity()
    cleanups.push(cleanup)

    const session = await createRealMeshSession({
      cliIdentity,
      signalingUrl: 'ws://signaling.local/',
      WebSocketCtor: net.FakeWebSocket,
      timeoutMs: 1000,
    })
    cleanups.push(session.close)

    assert.equal(session.mode, 'real')
    assert.equal(session.podId, cliIdentity.podId)
    assert.equal(session.peerNode.podId, cliIdentity.podId)
    assert.equal(session.signalingTransport.ready, true)
  })

  it('--relay opens a second transport, reachable on the session', async () => {
    const net = createFakeNetwork()
    net.registerServer('ws://signaling.local/', new FakeSignalingServer())
    net.registerServer('ws://relay.local/', new FakeRelayServer())
    const { cliIdentity, cleanup } = await buildTestIdentity()
    cleanups.push(cleanup)

    const session = await createRealMeshSession({
      cliIdentity,
      signalingUrl: 'ws://signaling.local/',
      relayUrl: 'ws://relay.local/',
      WebSocketCtor: net.FakeWebSocket,
      timeoutMs: 1000,
    })
    cleanups.push(session.close)

    assert.ok(session.relayTransport)
    assert.equal(session.relayTransport.ready, true)
  })

  it('without --relay, relayTransport is null', async () => {
    const net = createFakeNetwork()
    net.registerServer('ws://signaling.local/', new FakeSignalingServer())
    const { cliIdentity, cleanup } = await buildTestIdentity()
    cleanups.push(cleanup)

    const session = await createRealMeshSession({
      cliIdentity, signalingUrl: 'ws://signaling.local/', WebSocketCtor: net.FakeWebSocket, timeoutMs: 1000,
    })
    cleanups.push(session.close)
    assert.equal(session.relayTransport, null)
  })

  it('close() tears down cleanly', async () => {
    const net = createFakeNetwork()
    net.registerServer('ws://signaling.local/', new FakeSignalingServer())
    const { cliIdentity, cleanup } = await buildTestIdentity()
    cleanups.push(cleanup)

    const session = await createRealMeshSession({
      cliIdentity, signalingUrl: 'ws://signaling.local/', WebSocketCtor: net.FakeWebSocket, timeoutMs: 1000,
    })
    await session.close()
    assert.equal(session.signalingTransport.ready, false)
  })

  it('the full `meshctl hosts --signaling ...` chain wires together without hanging '
    + '(no --host given, so it fails as a usage error rather than negotiating WebRTC)', async () => {
    const net = createFakeNetwork()
    net.registerServer('ws://signaling.local/', new FakeSignalingServer())
    const { identityPath, cleanup } = await buildTestIdentity()
    cleanups.push(cleanup)

    // --quiet: internal mesh-subsystem diagnostics (PeerNode/registry/
    // signaling onLog calls) are plain human-readable lines, not JSON --
    // only the final {ok, error} document is guaranteed JSON on stderr,
    // and only once nothing else writes there first.
    const { code, stderr } = await runCli(
      ['hosts', '--signaling', 'ws://signaling.local/', '--identity', identityPath, '--timeout', '1000', '--quiet'],
      { WebSocketCtor: net.FakeWebSocket },
    )
    assert.equal(code, 2)
    assert.equal(JSON.parse(stderr).error.code, 'EUSAGE')
  })

  it('createRealMeshSession() without --signaling throws a usage error', async () => {
    const { cliIdentity, cleanup } = await buildTestIdentity()
    cleanups.push(cleanup)
    await assert.rejects(createRealMeshSession({ cliIdentity }), /EUSAGE|--signaling/)
  })
})
