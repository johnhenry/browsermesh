// Two real RTCPeerConnections, one Node process, no server.
//
// Every other WebRTC test in this repo runs against MockRTCPeerConnection,
// whose createOffer() returns the literal string 'mock-offer-sdp'. No ICE is
// gathered, no DTLS handshake happens, no packet moves. That is fine for
// proving the state machine, and it is why 4,506 passing tests did not notice
// that connectViaToken() closed its signaling channel before a single SDP
// message crossed it (issue #4).
//
// This file is the counterweight: real SDP, real ICE, real DTLS, real SCTP,
// real bytes over a real DataChannel -- driven through this package's own
// WebRTCPeerConnection, so the code under test is ours rather than the
// library's. The signaling "server" is two lines in pair() below: offer,
// answer and ICE candidates are handed across by direct function call.
//
// `iceServers: []` throughout. Host candidates only means loopback only,
// which means no STUN, no TURN, no NAT, no network dependency and no third
// party -- as hermetic as the mocked tests, just not fictional.
//
// Requires the optional devDependency `node-datachannel` (a native binding to
// libdatachannel, ~9 MB installed). When it is absent these tests skip rather
// than fail, so `npm test` still works on a bare checkout.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

/** @type {any} */ let ndc = null
/** @type {any} */ let ndcMain = null
try {
  ndc = await import('node-datachannel/polyfill')
  ndcMain = await import('node-datachannel')
} catch {
  // Optional dependency absent -- the suite below skips.
}

if (!ndc) {
  // Make the skip visible in the run output rather than silently absent.
  describe('WebRTC against real peers', () => {
    it('skipped: optional devDependency `node-datachannel` is not installed', () => {})
  })
}

const describeIfReal = ndc ? describe : describe.skip

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

describeIfReal('WebRTC against real peers', () => {
  let webrtc

  before(async () => {
    // webrtc.mjs reads RTCPeerConnection off the global at call time, so the
    // globals must be in place before anything constructs a connection. The
    // package's _setup-globals.mjs does not define them at all, which is why
    // supportsWebRTC() is false everywhere else in this suite.
    Object.assign(globalThis, {
      RTCPeerConnection: ndc.RTCPeerConnection,
      RTCIceCandidate: ndc.RTCIceCandidate,
      RTCSessionDescription: ndc.RTCSessionDescription,
    })
    webrtc = await import('../src/webrtc.mjs')
  })

  after(() => {
    // libdatachannel holds a worker pool that would keep the process alive.
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  /**
   * Build two WebRTCPeerConnections wired to each other by direct function
   * call. This is the whole "signaling server": no socket, no rendezvous.
   */
  function pair() {
    const alice = new webrtc.WebRTCPeerConnection({
      localPodId: 'pod-alice', remotePodId: 'pod-bob', iceServers: [],
    })
    const bob = new webrtc.WebRTCPeerConnection({
      localPodId: 'pod-bob', remotePodId: 'pod-alice', iceServers: [],
    })
    const relayed = { toBob: 0, toAlice: 0 }
    alice.onIceCandidate((c) => { relayed.toBob += 1; bob.addIceCandidate(c) })
    bob.onIceCandidate((c) => { relayed.toAlice += 1; alice.addIceCandidate(c) })
    return { alice, bob, relayed }
  }

  /** Run the offer/answer exchange and wait for both DataChannels to open. */
  async function connect({ alice, bob }) {
    const offer = await alice.createOffer()
    const answer = await bob.handleOffer(offer)
    await alice.handleAnswer(answer)
    await waitFor(() => alice.isOpen && bob.isOpen, 15_000, 'both data channels to open')
    return { offer, answer }
  }

  it('supportsWebRTC() is true once a real RTCPeerConnection is present', () => {
    assert.equal(webrtc.supportsWebRTC(), true)
  })

  it('exchanges a real offer and answer and opens a real DataChannel', async () => {
    const peers = pair()
    try {
      const { offer, answer } = await connect(peers)

      // A real offer, not 'mock-offer-sdp': the SDP has the shape the RFCs
      // give it, and each side minted its own ICE credentials and DTLS
      // fingerprint -- none of which a string literal can fake.
      assert.equal(offer.type, 'offer')
      assert.equal(answer.type, 'answer')
      assert.match(offer.sdp, /^v=0\r?$/m)
      assert.match(offer.sdp, /^m=application /m)   // the DataChannel m-line
      assert.match(offer.sdp, /^a=ice-ufrag:/m)
      assert.match(offer.sdp, /^a=fingerprint:sha-256 /m)
      assert.match(answer.sdp, /^a=fingerprint:sha-256 /m)
      assert.notEqual(
        offer.sdp.match(/^a=ice-ufrag:(.*)$/m)[1],
        answer.sdp.match(/^a=ice-ufrag:(.*)$/m)[1],
        'each peer must generate its own ICE credentials',
      )

      assert.equal(peers.alice.state, 'connected')
      assert.equal(peers.bob.state, 'connected')
      assert.ok(peers.relayed.toBob > 0, 'alice gathered and relayed ICE candidates')
      assert.ok(peers.relayed.toAlice > 0, 'bob gathered and relayed ICE candidates')
    } finally {
      peers.alice.close(); peers.bob.close()
    }
  })

  it('moves real bytes in both directions and counts them', async () => {
    const peers = pair()
    try {
      await connect(peers)

      const atBob = []
      const atAlice = []
      peers.bob.onMessage((m) => atBob.push(m))
      peers.alice.onMessage((m) => atAlice.push(m))

      peers.alice.send({ hello: 'bob' })
      peers.bob.send('plain string')

      await waitFor(() => atBob.length === 1 && atAlice.length === 1, 10_000, 'both messages to arrive')

      // send() JSON-serializes objects; the receive path parses JSON back.
      assert.deepEqual(atBob[0], { hello: 'bob' })
      assert.equal(atAlice[0], 'plain string')

      // Byte counters reflect what actually crossed the wire.
      const sent = JSON.stringify({ hello: 'bob' })
      assert.equal(peers.alice.stats.messagesOut, 1)
      assert.equal(peers.alice.stats.bytesSent, sent.length)
      assert.equal(peers.bob.stats.messagesIn, 1)
      assert.equal(peers.bob.stats.bytesReceived, sent.length)
    } finally {
      peers.alice.close(); peers.bob.close()
    }
  })

  it('a malformed remote ICE candidate is rejected without killing the process', async () => {
    // The regression this pins: addIceCandidate() used to call the underlying
    // async addIceCandidate() and discard the promise. libdatachannel rejects
    // a candidate it cannot parse, and an unhandled rejection terminates a
    // Node process by default -- so one peer sending junk down the signaling
    // channel took the process down. A malformed candidate is exactly what an
    // untrusted signaling channel delivers.
    const peers = pair()
    try {
      const offer = await peers.alice.createOffer()
      const answer = await peers.bob.handleOffer(offer)

      const accepted = await peers.bob.addIceCandidate({
        candidate: 'candidate:GARBAGE not a real candidate',
        sdpMid: '0',
        sdpMLineIndex: 0,
      })
      assert.equal(accepted, false, 'a malformed candidate is reported as rejected')

      // Give any stray rejection a turn of the loop to become fatal, then
      // show the connection still completes despite it.
      await new Promise((r) => setTimeout(r, 250))
      await peers.alice.handleAnswer(answer)
      await waitFor(() => peers.alice.isOpen && peers.bob.isOpen, 15_000, 'connection after a bad candidate')
    } finally {
      peers.alice.close(); peers.bob.close()
    }
  })

  it('addIceCandidate still throws synchronously before there is a connection', () => {
    const conn = new webrtc.WebRTCPeerConnection({
      localPodId: 'a', remotePodId: 'b', iceServers: [],
    })
    assert.throws(() => conn.addIceCandidate({ candidate: '' }), /No peer connection/)
    conn.close()
  })

  it('close() on one side is observed by the other, and releases both peer connections', async () => {
    // The regression this pins: close() returned early when the state was
    // already 'closed', and the DataChannel's onclose set exactly that state
    // without releasing anything. So a connection torn down by the *remote*
    // peer -- the ordinary case -- leaked its RTCPeerConnection, and no later
    // close() could reclaim it. Mocks cannot show this: nothing is held.
    // With a real stack the leaked connection keeps native threads alive and
    // this test file would never exit.
    const peers = pair()
    let bobSawClose = false
    try {
      await connect(peers)
      peers.bob.onClose(() => { bobSawClose = true })

      peers.alice.close()
      await waitFor(() => bobSawClose, 15_000, 'bob to observe the close')
      assert.equal(peers.bob.isOpen, false)
      assert.equal(peers.bob.state, 'closed')

      // 'No peer connection' is how this class reports a released #pc; any
      // other outcome means the underlying connection is still held.
      assert.throws(
        () => peers.bob.addIceCandidate({ candidate: '' }),
        /No peer connection/,
        'the remote-initiated close must release our own RTCPeerConnection',
      )
      assert.throws(
        () => peers.alice.addIceCandidate({ candidate: '' }),
        /No peer connection/,
      )
    } finally {
      peers.alice.close(); peers.bob.close()
    }
  })

  it('close() is idempotent and fires its close callbacks exactly once', async () => {
    const peers = pair()
    try {
      await connect(peers)
      let fired = 0
      peers.alice.onClose(() => { fired += 1 })
      peers.alice.close()
      peers.alice.close()
      peers.alice.close()
      assert.equal(fired, 1)
      assert.equal(peers.alice.state, 'closed')
    } finally {
      peers.alice.close(); peers.bob.close()
    }
  })
})
