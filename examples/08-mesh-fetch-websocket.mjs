/**
 * `browserMeshFetch()` and `BrowserMeshWebSocket` — the two web-standard-
 * API-shaped wrappers from the BrowserMeshFetch/BrowserMeshWebSocket plan
 * (`browsermesh-fetch-websocket.md`; independent of, and not sequenced
 * against, the CloudStorage mesh-native-services plan) — demonstrated
 * together over one pair of connected peers.
 *
 * `browserMeshFetch(url, init)` (Phase 2, `mesh-fetch.mjs`) gives calling
 * code the familiar `fetch(url) -> Response` shape for reaching a
 * mesh-addressable pod (`mesh://podId/path`) instead of raw `PeerNode`
 * primitives. `BrowserMeshWebSocket` (Phase 3, `mesh-websocket.mjs`) gives
 * it the familiar `WebSocket` instance shape for a persistent duplex
 * channel to a pod, including the accept/reject handshake a real
 * `WebSocket` server-side has no equivalent of (a real browser `WebSocket`
 * never sees its own connection get "rejected" as a first-class event — the
 * TCP handshake either succeeds or the constructor's `onerror` fires with no
 * further detail). Both ride the SAME underlying mesh-RPC/mesh-envelope
 * transport pattern every `MeshService` in this family uses
 * (`ctx.sendTo()`/`ctx.onIncomingData()`), just shaped differently: Phase
 * 2 is request/response, Phase 3 is open-once-then-free-form-duplex.
 *
 * Like `02-two-pods-discover-and-message.mjs`/`06-mesh-relay.mjs`/
 * `07-full-mesh-pipeline.mjs`, the connection between the two peers below is
 * a simulated in-process `sendTo`/`onIncomingData` bus, not a real WebRTC
 * `RTCPeerConnection` — this repo's own example convention (confirmed by
 * reading `06`/`07` before writing this file) reserves real WebRTC for the
 * `test/real-peer/*` suites (gated behind the native `node-datachannel`
 * dependency), since the point of an example is runnability with no native
 * deps, not proving real-WebRTC compatibility. Everything layered on top of
 * that simulated connection below — `createMeshRpcService`,
 * `createBrowserMeshFetch`, `createMeshWebSocketService`,
 * `BrowserMeshWebSocket` — is the real, unmodified production code from
 * `@johnhenry/browsermesh-apps`; only the transport is a stand-in.
 */

import assert from 'node:assert/strict'
import {
  attachService,
  createMeshRpcService,
  createBrowserMeshFetch,
  createMeshWebSocketService,
  BrowserMeshWebSocket,
} from '@johnhenry/browsermesh-apps'

const ALICE = 'pod-alice'
const BOB = 'pod-bob'

// ── Connect: a simulated bidirectional bus stands in for a real WebRTC
// DataChannel (see this file's module doc comment) — the same convention
// `06-mesh-relay.mjs`/`07-full-mesh-pipeline.mjs` already use.
function createNodePair(podIdA, podIdB) {
  const listenersA = new Set()
  const listenersB = new Set()
  return [
    { // alice's side
      podId: podIdA,
      onIncomingData(cb) { listenersA.add(cb); return () => listenersA.delete(cb) },
      async sendTo(_pubKey, data) { for (const cb of listenersB) cb(podIdA, data) },
    },
    { // bob's side
      podId: podIdB,
      onIncomingData(cb) { listenersB.add(cb); return () => listenersB.delete(cb) },
      async sendTo(_pubKey, data) { for (const cb of listenersA) cb(podIdB, data) },
    },
  ]
}

const [aliceNode, bobNode] = createNodePair(ALICE, BOB)
console.log('0. connected: alice <-> bob (simulated mesh connection) ✓')

// ── Part 1: browserMeshFetch — a fetch()-shaped request/response round trip
//
// Bob attaches a real mesh-RPC handler (Phase 1, `mesh-rpc.mjs`) deciding
// what `{method, path}` combinations it answers — authorization/routing is
// entirely this handler's own concern, the transport underneath has no
// opinion about it (see `mesh-rpc.mjs`'s own "AUTHORIZATION IS EXPLICITLY
// OUT OF SCOPE" doc comment).
const bobRpc = attachService(bobNode, undefined, createMeshRpcService({
  onRequest: async ({ method, path, body }) => {
    if (method === 'GET' && path === '/status') {
      return { status: 200, body: { ok: true, podId: BOB } }
    }
    if (method === 'POST' && path === '/echo') {
      return { status: 200, body: { youSaid: body } }
    }
    return { status: 404, body: { error: `no route for ${method} ${path}` } }
  },
}))

// Alice only needs the transport attached to get at `.api.request` —
// she registers no `onRequest` handler of her own since she's only calling
// out, not accepting inbound RPC calls in this example.
const aliceRpc = attachService(aliceNode, undefined, createMeshRpcService({}))
const browserMeshFetch = createBrowserMeshFetch(aliceRpc.api)

const statusRes = await browserMeshFetch(`mesh://${BOB}/status`)
assert.equal(statusRes.status, 200)
assert.equal(statusRes.headers.get('content-type'), 'application/json')
const statusBody = await statusRes.json()
assert.deepEqual(statusBody, { ok: true, podId: BOB })
console.log('1. browserMeshFetch GET mesh://pod-bob/status ->', statusBody, '✓')

const echoRes = await browserMeshFetch(`mesh://${BOB}/echo`, {
  method: 'POST',
  body: { hello: 'mesh' },
})
const echoBody = await echoRes.json()
assert.deepEqual(echoBody, { youSaid: { hello: 'mesh' } })
console.log('2. browserMeshFetch POST mesh://pod-bob/echo ->', echoBody, '✓')

// A route bob's handler doesn't recognize resolves a real (non-2xx) Response
// rather than rejecting — matching real fetch()'s own error-vs-reject
// semantics (see mesh-fetch.mjs's "ERROR-VS-REJECT SEMANTICS" doc comment):
// only a network-level failure (unreachable peer, timeout) rejects.
const missingRes = await browserMeshFetch(`mesh://${BOB}/nope`)
assert.equal(missingRes.status, 404)
console.log('3. browserMeshFetch GET mesh://pod-bob/nope -> resolved 404 Response (not a rejection) ✓')

// ── Part 2: BrowserMeshWebSocket — a persistent duplex channel, including
// the accept/reject handshake
//
// Bob attaches a mesh-websocket service (Phase 3, `mesh-websocket.mjs`)
// that only accepts connections on '/chat' — any other path is rejected,
// exactly like a real server deciding whether to upgrade a given request.
let resolveBobReady
const bobReady = new Promise((resolve) => { resolveBobReady = resolve })
const bobWs = attachService(bobNode, undefined, createMeshWebSocketService({
  onConnection: (_fromPubKey, path) => path === '/chat',
  onIncomingConnection: (session) => {
    session.onmessage = (event) => {
      console.log('   [bob] received:', event.data)
      session.send(`echo: ${event.data}`)
    }
    resolveBobReady()
  },
}))

// Alice originates the connection directly — a client-role
// BrowserMeshWebSocket needs no MeshService of its own attached (see
// mesh-websocket.mjs's own doc comment); it only needs `peerNode`, the one
// required deviation from the real `WebSocket` constructor (there is no
// ambient mesh connection the way there's an ambient browser networking
// stack for `new WebSocket(url)`).
const chatSocket = new BrowserMeshWebSocket(`mesh://${BOB}/chat`, { peerNode: aliceNode })
const chatOpen = new Promise((resolve, reject) => {
  chatSocket.onopen = resolve
  chatSocket.onerror = (event) => reject(new Error(event.message))
})
// Wait for BOTH alice's own `onopen` AND bob's `onIncomingConnection` to have
// run before sending anything: `createMeshWebSocketService()` sends the
// `ws-open-ack` that fires alice's `onopen` *before* it calls
// `onIncomingConnection` (see mesh-websocket.mjs's `handleOpen()`), so over
// this example's synchronous in-process bus (unlike a real network, which
// would never race this tightly) a message sent the instant `onopen` fires
// can outrun bob's own `session.onmessage` wiring above -- the same reason
// this package's own `test/mesh-websocket.test.mjs` waits a beat after open
// before exercising message exchange.
await Promise.all([chatOpen, bobReady])
console.log('4. BrowserMeshWebSocket accept handshake: alice connected to mesh://pod-bob/chat ✓')

const replyPromise = new Promise((resolve) => { chatSocket.onmessage = (event) => resolve(event.data) })
chatSocket.send('hello bob')
const reply = await replyPromise
assert.equal(reply, 'echo: hello bob')
console.log('5. duplex exchange: alice -> "hello bob" -> bob -> alice ->', JSON.stringify(reply), '✓')

const closePromise = new Promise((resolve) => { chatSocket.onclose = resolve })
chatSocket.close()
const closeEvent = await closePromise
assert.equal(closeEvent.code, 1000)
console.log('6. chatSocket.close() -> readyState CLOSED (code', closeEvent.code, ') ✓')

// Connecting to a path bob's onConnection hook refuses demonstrates the
// REJECT half of the handshake: onclose fires with code 4403 (this family's
// private-use "rejected" code — see mesh-websocket.mjs's doc comment) and
// no onopen ever fires.
let badSocketOpened = false
const badSocket = new BrowserMeshWebSocket(`mesh://${BOB}/admin`, { peerNode: aliceNode })
badSocket.onopen = () => { badSocketOpened = true }
const rejectionEvent = await new Promise((resolve) => { badSocket.onclose = resolve })
assert.equal(badSocketOpened, false)
assert.equal(rejectionEvent.code, 4403)
console.log('7. BrowserMeshWebSocket reject handshake: mesh://pod-bob/admin refused (code', rejectionEvent.code, ', reason', JSON.stringify(rejectionEvent.reason), ') ✓')

await aliceRpc.teardown()
await bobRpc.teardown()
await bobWs.teardown()

console.log('\nok: browserMeshFetch request/response (including a non-2xx route) and BrowserMeshWebSocket duplex messaging (including both the accept and reject handshake) both working over one mesh connection')
