// Issue #13, against two real RTCPeerConnections in one Node process.
//
// The bug this file pins cannot be seen through MockRTCPeerConnection at all.
// The mock's createOffer() returns the string 'mock-offer-sdp' and its
// setRemoteDescription() stores whatever it is handed, so a peer answering a
// renegotiation offer with a *different connection's* ICE credentials and
// DTLS fingerprint looks exactly like a peer answering correctly. Only a real
// stack refuses it, and only a real stack can show that the fixed path keeps
// moving bytes. The measurement that opened the issue:
//
//   connected; a.isOpen = true
//   reconnect() -> offer, a.state = connecting a.isOpen = false
//   b.handleOffer(restart offer) produced an answer; b.state = connecting
//   FAILED: libdatachannel error while adding remote description:
//           Invalid ICE settings from remote SDP
//   final: a.isOpen = false b.isOpen = false
//
// Same harness shape as webrtc-real-peer.test.mjs: `node-datachannel` is an
// optional devDependency, `iceServers: []` means host candidates on loopback
// only, and the whole signaling "server" is two function calls in pair().

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
  describe('WebRTC renegotiation against real peers', () => {
    it('skipped: optional devDependency `node-datachannel` is not installed', () => {})
  })
}

const describeIfReal = ndc ? describe : describe.skip

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

describeIfReal('WebRTC renegotiation against real peers', () => {
  let webrtc

  before(async () => {
    Object.assign(globalThis, {
      RTCPeerConnection: ndc.RTCPeerConnection,
      RTCIceCandidate: ndc.RTCIceCandidate,
      RTCSessionDescription: ndc.RTCSessionDescription,
    })
    webrtc = await import('../src/webrtc.mjs')
  })

  after(() => {
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  /** Two peers wired to each other by direct function call. */
  function pair() {
    const alice = new webrtc.WebRTCPeerConnection({
      localPodId: 'pod-alice', remotePodId: 'pod-bob', iceServers: [],
    })
    const bob = new webrtc.WebRTCPeerConnection({
      localPodId: 'pod-bob', remotePodId: 'pod-alice', iceServers: [],
    })
    // A candidate can arrive before the remote description is set, and
    // addIceCandidate() rejects when it does. Swallow it here so a candidate
    // race cannot fail a test about renegotiation.
    const relay = (fn) => { try { const r = fn(); if (r && r.catch) r.catch(() => {}) } catch { /* ignore */ } }
    // Bob's candidates go to whoever he is currently negotiating with, which
    // is how a signaling channel behaves and is not always `alice`: the last
    // test below replaces her with a peer that restarted.
    const bobPeer = { current: alice }
    alice.onIceCandidate((c) => relay(() => bob.addIceCandidate(c)))
    bob.onIceCandidate((c) => relay(() => bobPeer.current.addIceCandidate(c)))
    return { alice, bob, bobPeer, relay }
  }

  async function connect({ alice, bob }) {
    const offer = await alice.createOffer()
    const answer = await bob.handleOffer(offer)
    await alice.handleAnswer(answer)
    await waitFor(() => alice.isOpen && bob.isOpen, 15_000, 'both data channels to open')
    return offer
  }

  it('a renegotiation offer is answered on the live connection, and the connection survives', async () => {
    const peers = pair()
    try {
      await connect(peers)
      const received = []
      peers.bob.onMessage((m) => received.push(m))
      peers.alice.send({ n: 1 })
      await waitFor(() => received.length === 1, 10_000, 'the first message')

      // force: the connection is healthy, which is precisely when the old
      // code destroyed it. Everything below is what used to fail.
      const offer = await peers.alice.reconnect({ force: true })
      assert.equal(offer.renegotiation, true)
      assert.equal(peers.alice.isOpen, true, 'creating the offer must not close anything')

      const answer = await peers.bob.handleOffer(offer)
      assert.equal(answer.renegotiation, true)
      assert.equal(peers.bob.isOpen, true, 'bob answers on the connection he already has')

      // This is the line that threw `Invalid ICE settings from remote SDP`.
      await peers.alice.handleAnswer(answer)

      assert.equal(peers.alice.isOpen, true)
      assert.equal(peers.bob.isOpen, true)

      // And the channel still carries traffic afterwards, which is the only
      // proof that survives a stack that reports states optimistically.
      peers.alice.send({ n: 2 })
      await waitFor(() => received.length === 2, 10_000, 'a message after renegotiation')
      assert.deepEqual(received, [{ n: 1 }, { n: 2 }])
    } finally {
      peers.alice.close(); peers.bob.close()
    }
  })

  it('reconnect() on a healthy connection changes nothing at all', async () => {
    const peers = pair()
    try {
      await connect(peers)
      const received = []
      peers.bob.onMessage((m) => received.push(m))

      assert.equal(await peers.alice.reconnect(), null)

      // The measured failure was `a.isOpen = false` on a working connection,
      // before any signaling had happened.
      assert.equal(peers.alice.isOpen, true)
      assert.equal(peers.alice.state, 'connected')
      peers.alice.send({ still: 'here' })
      await waitFor(() => received.length === 1, 10_000, 'traffic after a declined reconnect')
      assert.deepEqual(received, [{ still: 'here' }])
    } finally {
      peers.alice.close(); peers.bob.close()
    }
  })

  it('an unmarked re-offer is recognised by its SDP session id', async () => {
    // A peer running a build that predates the `renegotiation` flag. Without
    // the session-id fallback this is the original bug verbatim.
    const peers = pair()
    try {
      const original = await connect(peers)
      const received = []
      peers.bob.onMessage((m) => received.push(m))

      const { renegotiation, ...unmarked } = await peers.alice.reconnect({ force: true })
      assert.equal(renegotiation, true)
      assert.equal(unmarked.renegotiation, undefined, 'the marker really is gone from the wire')
      // What the fallback keys off: the re-offer reuses the session id of the
      // offer bob already applied (RFC 3264), so bob can tell without being told.
      assert.equal(webrtc.sdpSessionId(unmarked.sdp), webrtc.sdpSessionId(original.sdp))

      const answer = await peers.bob.handleOffer(unmarked)
      await peers.alice.handleAnswer(answer)

      assert.equal(peers.alice.isOpen, true)
      assert.equal(peers.bob.isOpen, true)
      peers.alice.send({ unmarked: true })
      await waitFor(() => received.length === 1, 10_000, 'traffic after an unmarked renegotiation')
      assert.deepEqual(received, [{ unmarked: true }])
    } finally {
      peers.alice.close(); peers.bob.close()
    }
  })

  // NOT here, deliberately: the other branch of handleOffer() -- a *fresh*
  // offer arriving on a live connection, which supersedes and releases the
  // old RTCPeerConnection. It works against real peers (verified by hand: the
  // restarted peer's offer carries a new session id, bob answers it on a new
  // connection, and the rebuilt channel carries real bytes), but the peer
  // whose connection was superseded learns of it through its DataChannel's
  // `onclose`, and on `main` that path sets the state to 'closed' without
  // releasing the RTCPeerConnection -- so a later close() returns early and
  // the connection is leaked. With a native stack a leaked connection keeps
  // the process alive, and this file would never exit.
  //
  // PR #14 fixes exactly that in close(). Running this file with PR #14's
  // close() applied locally, the superseding test passes and the process
  // exits 0 in 291ms. It belongs in the suite once #14 lands; until then the
  // supersede path is pinned at mock level in webrtc.test.mjs
  // ('releases the superseded peer connection without reporting a close').
})
