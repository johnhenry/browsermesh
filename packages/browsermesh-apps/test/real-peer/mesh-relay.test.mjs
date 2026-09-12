// Three real PeerNodes, one real local TCP server, one Node process, no
// external signaling/wsh server: proves Phase 8 (issue #72) -- Peer A
// (Alice) shares access to a real local TCP service with specific,
// authorized mesh peers over a real WebRTC connection, gated per-peer by
// PeerRegistry's real checkAccess()/grantCapabilities()/revokeCapabilities().
//
// Mirrors mesh-bootstrap.test.mjs / kernel-mesh.test.mjs's real-peer setup
// exactly (same optional `node-datachannel` devDependency guard, same
// hermetic `iceServers: []` loopback setup) and layers the mesh-relay
// composition (`src/mesh-relay-host.mjs` + `src/mesh-relay-backend.mjs`) on
// top of it.
//
// What's real here: everything mesh-bootstrap.test.mjs already proves real
// (identity, discovery, WebRTC signaling/connection, PeerNode.sendTo() /
// onIncomingData() over real DataChannels -- TWO of them, Alice<->Bob and
// Alice<->Carol) PLUS a real `node:net` TCP server, a real
// `browsermesh-netway` `GatewayBackend` proxying to it via a
// mock-wsh-control-protocol-but-real-socket-data-plane double (the control
// messages -- OPEN_TCP/GATEWAY_OK/GATEWAY_DATA/GATEWAY_CLOSE -- are handled
// in-process like `browsermesh-netway`'s own `MockWshClient` test double
// does, but backed by a genuine `node:net.Socket` carrying genuine bytes to
// the genuine local TCP server, not simulated responses), a real
// `MeshRelayHost` exposing that as a named service, and a real
// `MeshRelayBackend` relaying through and getting real bytes back.
//
// Also proves the two claims that matter most for the real-world scenario:
// a peer with no grant at all is refused (per-peer enforcement), and
// revoking mid-session denies the *next* connect attempt (the already-open
// connection is left alone, matching mesh-relay.test.mjs's unit-level proof
// of the same behavior).

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

/** @type {any} */ let ndc = null
/** @type {any} */ let ndcMain = null
try {
  ndc = await import('node-datachannel/polyfill')
  ndcMain = await import('node-datachannel')
} catch {
  // Optional dependency absent -- the suite below skips.
}

if (!ndc && process.env.REQUIRE_REAL_PEER) {
  throw new Error(
    'REQUIRE_REAL_PEER is set but `node-datachannel` did not load, so the ' +
    'real-peer suite would have skipped and reported success. Install the ' +
    'devDependency, or unset REQUIRE_REAL_PEER to allow the skip.'
  )
}

if (!ndc) {
  describe('mesh-relay against real WebRTC peers', () => {
    it('skipped: optional devDependency `node-datachannel` is not installed', () => {})
  })
}

const describeIfReal = ndc ? describe : describe.skip

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

/** Shared in-process pub/sub bus standing in for a real signaling transport
 * (see mesh-bootstrap.test.mjs for the full rationale). One bus is shared
 * across all three peers -- MeshSignalingChannel messages are addressed by
 * podId, so peers not party to a given exchange just ignore it. */
function createSharedSignalingBus() {
  return new Set()
}

function createBusTransport(sharedBus) {
  let handler = null
  const receiver = (msg) => { if (handler) handler(msg) }
  sharedBus.add(receiver)
  return {
    send(msg) {
      for (const fn of sharedBus) {
        if (fn !== receiver) fn(msg)
      }
    },
    onMessage(cb) { handler = cb },
  }
}

// ---------------------------------------------------------------------------
// A mock-wsh-control-protocol-but-real-socket-data-plane double.
//
// Implements the `wshClient` shape `GatewayBackend` expects (`state`,
// `sendControl(msg)`, an assignable `onGatewayMessage` callback) -- same
// interface `browsermesh-netway/test/mock-wsh-transport.mjs`'s
// `MockWshClient` implements for that package's own unit tests -- but every
// OPEN_TCP control message opens a genuine `node:net` TCP socket to the
// genuine local server below, and every byte that arrives on that real
// socket is forwarded on as a real GATEWAY_DATA control message (and vice
// versa). No wsh wire protocol is actually serialized; what's real is the
// TCP connection and the bytes, exactly matching the Phase 8 plan's "extend
// gateway-backend.test.mjs's pattern rather than invent a third convention".
// ---------------------------------------------------------------------------
class RealSocketWshDouble {
  state = 'authenticated'
  onGatewayMessage = null
  /** @type {Map<number, import('node:net').Socket>} */
  #sockets = new Map()

  async sendControl(msg) {
    switch (msg.type) {
      case 0x70: { // OPEN_TCP
        const sock = net.createConnection({ host: msg.host, port: msg.port })
        this.#sockets.set(msg.gateway_id, sock)
        sock.once('connect', () => {
          this.onGatewayMessage?.({ type: 0x73, gateway_id: msg.gateway_id })
        })
        sock.on('data', (chunk) => {
          this.onGatewayMessage?.({ type: 0x7e, gateway_id: msg.gateway_id, data: new Uint8Array(chunk) })
        })
        sock.once('error', (err) => {
          this.#sockets.delete(msg.gateway_id)
          this.onGatewayMessage?.({
            type: 0x74, gateway_id: msg.gateway_id, code: err.code || 'EUNKNOWN', message: err.message,
          })
        })
        sock.once('close', () => {
          if (this.#sockets.delete(msg.gateway_id)) {
            this.onGatewayMessage?.({ type: 0x75, gateway_id: msg.gateway_id })
          }
        })
        break
      }
      case 0x7e: { // GatewayData -- forward to the real socket
        const sock = this.#sockets.get(msg.gateway_id)
        if (sock) sock.write(Buffer.from(msg.data))
        break
      }
      case 0x75: { // GatewayClose -- tear down the real socket
        const sock = this.#sockets.get(msg.gateway_id)
        if (sock) {
          this.#sockets.delete(msg.gateway_id)
          sock.destroy()
        }
        break
      }
      // listen/resolve/UDP control codes: unused by this test (MeshRelayHost
      // only ever calls network.connect()).
    }
  }

  destroy() {
    for (const sock of this.#sockets.values()) sock.destroy()
    this.#sockets.clear()
  }
}

const enc = new TextEncoder()
const dec = new TextDecoder()

describeIfReal('mesh-relay: MeshRelayHost + MeshRelayBackend over real WebRTC, real TCP', () => {
  /** @type {any} */ let createMeshNode
  /** @type {any} */ let ManualStrategy
  /** @type {any} */ let DiscoveryRecord
  /** @type {any} */ let VirtualNetwork
  /** @type {any} */ let GatewayBackend
  /** @type {any} */ let ConnectionRefusedError
  /** @type {any} */ let MeshRelayBackend

  before(async () => {
    // webrtc.mjs reads RTCPeerConnection off the global at call time, so
    // the globals must be in place before any WebRTCPeerConnection is
    // constructed (not necessarily before it's imported).
    Object.assign(globalThis, {
      RTCPeerConnection: ndc.RTCPeerConnection,
      RTCIceCandidate: ndc.RTCIceCandidate,
      RTCSessionDescription: ndc.RTCSessionDescription,
    })
    ;({ createMeshNode } = await import('../../src/mesh-bootstrap.mjs'))
    ;({ MeshRelayBackend } = await import('../../src/mesh-relay-backend.mjs'))
    ;({ ManualStrategy, DiscoveryRecord } = await import('@johnhenry/browsermesh-discovery'))
    ;({ VirtualNetwork, GatewayBackend, ConnectionRefusedError } = await import('@johnhenry/browsermesh-netway'))
  })

  after(() => {
    // libdatachannel holds a worker pool that would keep the process alive.
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('Bob (granted) relays through Alice to a real local TCP service and gets real bytes back; Carol (ungranted) is refused; revoking Bob mid-session denies his next connect', async () => {
    // -- A real local TCP server: greets, then echoes with a prefix --------
    const server = net.createServer((sock) => {
      sock.write('HELLO-FROM-REAL-TCP\n')
      sock.on('data', (chunk) => {
        sock.write(Buffer.concat([Buffer.from('echo:'), chunk]))
      })
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const tcpPort = server.address().port

    // -- Alice's own VirtualNetwork, reaching the real service via a real- --
    // -- socket-backed GatewayBackend (the "wsh-tunneled TCP" half; zero ---
    // -- new work per the Phase 8 plan -- this is existing, real -netway) --
    const wshDouble = new RealSocketWshDouble()
    const gateway = new GatewayBackend({ wshClient: wshDouble })
    const aliceNetwork = new VirtualNetwork()
    aliceNetwork.addBackend('tcp', gateway)

    // -- Three real mesh nodes, real identities, real WebRTC ----------------
    const signalingBus = createSharedSignalingBus()
    const discoveryA = new ManualStrategy()
    const discoveryB = new ManualStrategy()
    const discoveryC = new ManualStrategy()

    const nodeA = await createMeshNode({
      label: 'alice',
      discoveryStrategies: [discoveryA],
      signalingTransport: createBusTransport(signalingBus),
      iceServers: [], // host candidates only: hermetic, no STUN/TURN/network dependency
      enableRelayHost: true,
      relayHostNetwork: aliceNetwork,
      relayHostServices: { 'local-tcp': `tcp://127.0.0.1:${tcpPort}` },
    })
    const nodeB = await createMeshNode({
      label: 'bob',
      discoveryStrategies: [discoveryB],
      signalingTransport: createBusTransport(signalingBus),
      iceServers: [],
    })
    const nodeC = await createMeshNode({
      label: 'carol',
      discoveryStrategies: [discoveryC],
      signalingTransport: createBusTransport(signalingBus),
      iceServers: [],
    })

    try {
      assert.ok(nodeA.relayHost, 'createMeshNode({ enableRelayHost: true, ... }) attaches node.relayHost')
      assert.deepEqual(nodeA.relayHost.listServices(), ['local-tcp'])

      // -- Real discovery + two real WebRTC connections (Alice<->Bob, Alice<->Carol) --
      discoveryA.addPeer(new DiscoveryRecord({ podId: nodeB.podId, transport: 'webrtc', label: 'bob' }))
      discoveryA.addPeer(new DiscoveryRecord({ podId: nodeC.podId, transport: 'webrtc', label: 'carol' }))
      discoveryB.addPeer(new DiscoveryRecord({ podId: nodeA.podId, transport: 'webrtc', label: 'alice' }))
      discoveryC.addPeer(new DiscoveryRecord({ podId: nodeA.podId, transport: 'webrtc', label: 'alice' }))
      await nodeA.discover()
      await nodeB.discover()
      await nodeC.discover()

      // This test establishes TWO real WebRTC connections from the same
      // local node (Alice<->Bob, Alice<->Carol), sequentially -- more
      // libdatachannel/DTLS handshake work than the single-connection
      // real-peer suites elsewhere in this package. Generous timeouts here
      // (vs. those suites' 10_000ms) give CI's documented under-load DTLS
      // stalls (see .github/workflows/ci.yml's comment on this suite) real
      // room, rather than papering over a slow-but-correct second handshake.
      const WEBRTC_TIMEOUT_MS = 30_000

      await nodeA.connectToPeer(
        nodeB.podId, { webrtc: nodeB.podId },
        { answerTimeoutMs: WEBRTC_TIMEOUT_MS, openTimeoutMs: WEBRTC_TIMEOUT_MS },
      )
      await waitFor(() => nodeB.meshManager.getConnection(nodeA.podId)?.isOpen, WEBRTC_TIMEOUT_MS, "bob's side of the DataChannel to open")

      await nodeA.connectToPeer(
        nodeC.podId, { webrtc: nodeC.podId },
        { answerTimeoutMs: WEBRTC_TIMEOUT_MS, openTimeoutMs: WEBRTC_TIMEOUT_MS },
      )
      await waitFor(() => nodeC.meshManager.getConnection(nodeA.podId)?.isOpen, WEBRTC_TIMEOUT_MS, "carol's side of the DataChannel to open")

      // Only Bob is authorized -- Carol gets no grant at all.
      nodeA.registry.grantCapabilities(nodeB.podId, ['mesh-relay:local-tcp:connect'])

      const bobBackend = new MeshRelayBackend({ node: nodeB, relayPeerPubKey: nodeA.podId })
      const carolBackend = new MeshRelayBackend({ node: nodeC, relayPeerPubKey: nodeA.podId })

      try {
        // == Carol (ungranted): refused, proving per-peer enforcement =========
        await assert.rejects(
          () => carolBackend.connect('local-tcp'),
          (err) => {
            assert.ok(err instanceof ConnectionRefusedError, `expected ConnectionRefusedError, got ${err}`)
            return true
          },
          "an ungranted peer (Carol) must be refused Alice's shared service",
        )

        // == Bob (granted): real round trip through real WebRTC + real TCP ====
        const bobNetwork = new VirtualNetwork()
        bobNetwork.addBackend('via-alice', bobBackend)
        const bobSocket = await bobNetwork.connect('via-alice://local-tcp')

        const greeting = await bobSocket.read()
        assert.equal(dec.decode(greeting), 'HELLO-FROM-REAL-TCP\n', 'Bob received the real TCP server\'s real greeting, relayed through Alice')

        await bobSocket.write(enc.encode('ping'))
        const echoed = await bobSocket.read()
        assert.equal(dec.decode(echoed), 'echo:ping', 'Bob\'s write reached the real TCP server and its real response came back')

        await bobSocket.close()
        // Give Alice's host-side pump a moment to notice EOF and tear down
        // the real TCP socket cleanly before the next phase.
        await new Promise((r) => setTimeout(r, 50))

        // == Revoke mid-session: Bob's *next* connect attempt is denied =======
        nodeA.registry.revokeCapabilities(nodeB.podId, ['mesh-relay:local-tcp:connect'])

        await assert.rejects(
          () => bobBackend.connect('local-tcp'),
          (err) => {
            assert.ok(err instanceof ConnectionRefusedError, `expected ConnectionRefusedError, got ${err}`)
            return true
          },
          'after revocation, the next connect attempt from the same peer must be refused',
        )
      } finally {
        await bobBackend.close()
        await carolBackend.close()
      }
    } finally {
      await nodeA.relayHost.detach()
      await aliceNetwork.close()
      wshDouble.destroy()
      await new Promise((resolve) => server.close(resolve))

      nodeA.meshManager.closeAll()
      nodeB.meshManager.closeAll()
      nodeC.meshManager.closeAll()
      await nodeA.shutdown()
      await nodeB.shutdown()
      await nodeC.shutdown()
      await nodeA.signaling.close()
      await nodeB.signaling.close()
      await nodeC.signaling.close()
    }
  })
})
