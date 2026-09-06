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

// A skipped suite reports success. That is right for a contributor who has
// not built the native binding, and wrong for CI, where a silently-absent
// dependency would turn this whole file into decoration while the run stays
// green. REQUIRE_REAL_PEER=1 (set by the CI step) makes the absence fatal.
if (!ndc && process.env.REQUIRE_REAL_PEER) {
  throw new Error(
    'REQUIRE_REAL_PEER is set but `node-datachannel` did not load, so the ' +
    'real-peer suite would have skipped and reported success. Install the ' +
    'devDependency, or unset REQUIRE_REAL_PEER to allow the skip.'
  )
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
    webrtc = await import('../../src/webrtc.mjs')
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
    /*
     * One retry, because the first attempt fails outright often enough to
     * dominate this suite (browsermesh#26): ICE reaches `connected` on both
     * sides and the DTLS handshake then fails, so the DataChannel never
     * opens and the wait burns its whole timeout.
     *
     * A retry is the right shape rather than a longer wait. The failure is
     * terminal -- `connectionState` goes to `failed`, which nothing recovers
     * from -- and a success takes about 700ms, so waiting longer only makes
     * the failure slower. Both peer connections are rebuilt on the way:
     * `createOffer()` assigns a fresh RTCPeerConnection, and `handleOffer()`
     * releases the old one before making its own.
     *
     * The first attempt gets a short deadline so the retry is quick; the
     * second gets the full one so a genuinely slow machine is not failed for
     * being slow.
     */
    for (let attempt = 0; ; attempt += 1) {
      const offer = await alice.createOffer()
      const answer = await bob.handleOffer(offer)
      await alice.handleAnswer(answer)
      try {
        await waitFor(
          () => alice.isOpen && bob.isOpen,
          attempt === 0 ? 5_000 : 15_000,
          'both data channels to open',
        )
        return { offer, answer }
      } catch (error) {
        if (attempt >= 1) throw error
      }
    }
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

  it('reports a connection the stack gave up on, instead of waiting forever', async () => {
    /*
     * A DETERMINISTIC handshake failure, which the flaky one (#26) is not.
     *
     * Flipping one hex pair of the DTLS fingerprint in the answer produces an
     * answer that cannot verify -- what a corrupted or hostile one looks like.
     * ICE still succeeds; DTLS then cannot, and libdatachannel closes both
     * peer connections about 50ms in.
     *
     * Before this was handled, that was completely silent. `onconnectionstatechange`
     * acted on `failed` and `disconnected` and let `closed` fall through, so
     * twelve seconds later `state` was still `connecting`, no error had fired,
     * and no close callback had run:
     *
     *     t=   0ms  pc0[ice=checking conn=connecting]
     *     t=  52ms  pc0[ice=closed   conn=closed]
     *     t=12013ms  state=connecting  error=none
     *
     * A caller waiting on `isOpen` waited forever, and WebRTCMeshManager --
     * which reconnects on `onError` -- never heard anything to reconnect from.
     * The DataChannel's close path cannot cover it: the channel never opened,
     * so `dc.onclose` never fires.
     *
     * This is a real-peer test because a mock cannot fail a certificate
     * check. That is the whole point: the mock suite passed throughout.
     */
    const peers = pair()
    try {
      const errors = []
      peers.alice.onError((error) => errors.push(error.message))

      const offer = await peers.alice.createOffer()
      const answer = await peers.bob.handleOffer(offer)

      const corrupted = answer.sdp.replace(
        /^(a=fingerprint:sha-256 )([0-9A-Fa-f:]+)$/m,
        (_, head, fingerprint) => {
          const bytes = fingerprint.split(':')
          bytes[0] = bytes[0] === 'AA' ? 'BB' : 'AA'
          return head + bytes.join(':')
        },
      )
      assert.notEqual(corrupted, answer.sdp, 'the fingerprint was actually corrupted')

      await peers.alice.handleAnswer({ ...answer, sdp: corrupted })

      // Promptly, not eventually. The stack gives up in about 50ms; the
      // generous deadline here is about tolerating a slow machine, not about
      // waiting for something slow to happen.
      await waitFor(() => errors.length > 0, 8_000, 'an error to be reported')

      assert.equal(peers.alice.state, 'closed', 'a dead connection does not stay "connecting"')
      assert.equal(peers.alice.isOpen, false)
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
