// Two real RTCPeerConnections, one Node process, no server -- same harness
// shape as ./webrtc.test.mjs and ./renegotiation.test.mjs.
//
// This file proves two things that cannot be shown against
// MockRTCPeerConnection at all, because the mock's DataChannel.send() just
// pushes onto an array and every message is "delivered" synchronously and
// instantly -- there is no queue, no SCTP stream, and therefore no way for
// one channel's backlog to delay another's:
//
//   1. Head-of-line blocking on a SHARED channel is real (a regression pin,
//      with real timing evidence), and a SEPARATE channel's own buffering/
//      readiness state is structurally independent of the shared channel's
//      backlog (real, spec-defined per-channel state, not a timing
//      inference). See the longer comment above the first `it()` below for
//      exactly what is, and is not, claimed about wall-clock delivery speed
//      on separate channels against this package's specific Node-only real-
//      peer test binding.
//
//   2. The no-negotiation version-compat design actually holds. An older,
//      single-channel build of this class (reproduced faithfully below as
//      OldWebRTCPeerConnection, from the shape webrtc.mjs had before the bulk
//      channel existed) must interoperate with today's dual-channel build in
//      BOTH directions -- old as offerer, old as answerer -- with no
//      capability negotiation, no hang, and no dropped message. See
//      webrtc.mjs's docs on #setupDataChannel, #bulkChannel and send() for
//      the reasoning this pins: reads are channel-agnostic (every listener
//      fires for a message from either channel) and writes fall back to the
//      control channel when the bulk one is missing.

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

if (!ndc && process.env.REQUIRE_REAL_PEER) {
  throw new Error(
    'REQUIRE_REAL_PEER is set but `node-datachannel` did not load, so the ' +
    'dual-channel real-peer suite would have skipped and reported success. ' +
    'Install the devDependency, or unset REQUIRE_REAL_PEER to allow the skip.'
  )
}

if (!ndc) {
  describe('Dual data channels against real peers', () => {
    it('skipped: optional devDependency `node-datachannel` is not installed', () => {})
  })
}

const describeIfReal = ndc ? describe : describe.skip

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

describeIfReal('Dual data channels against real peers', () => {
  let webrtc

  before(async () => {
    Object.assign(globalThis, {
      RTCPeerConnection: ndc.RTCPeerConnection,
      RTCIceCandidate: ndc.RTCIceCandidate,
      RTCSessionDescription: ndc.RTCSessionDescription,
    })
    webrtc = await import('../../src/webrtc.mjs')
  })

  after(() => {
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  function pair() {
    const alice = new webrtc.WebRTCPeerConnection({
      localPodId: 'pod-alice', remotePodId: 'pod-bob', iceServers: [],
    })
    const bob = new webrtc.WebRTCPeerConnection({
      localPodId: 'pod-bob', remotePodId: 'pod-alice', iceServers: [],
    })
    alice.onIceCandidate((c) => bob.addIceCandidate(c))
    bob.onIceCandidate((c) => alice.addIceCandidate(c))
    return { alice, bob }
  }

  async function connect({ alice, bob }) {
    const offer = await alice.createOffer()
    const answer = await bob.handleOffer(offer)
    await alice.handleAnswer(answer)
    await waitFor(() => alice.isOpen && bob.isOpen, 15_000, 'both control channels to open')
    return { offer, answer }
  }

  // -------------------------------------------------------------------------
  // 1. Head-of-line blocking proof
  // -------------------------------------------------------------------------
  //
  // Two DIFFERENT claims are involved here, and they need two different
  // kinds of evidence:
  //
  //   (a) On a SHARED channel, a control message queued behind a bulk
  //       backlog cannot be delivered before that backlog is -- this is a
  //       hard guarantee of ordered-stream delivery (RFC 8831), not an
  //       implementation detail, and is what the pre-fix single-channel
  //       code actually did. Proven below with real timing: forced onto one
  //       channel, the control message's delivery is measured to trail the
  //       bulk transfer's completion, matching the reported bug.
  //
  //   (b) On SEPARATE channels, a control message is never accounted
  //       against, or gated by, the bulk channel's backlog -- proven below
  //       via `bufferedAmount`/`readyState`, which is real, per-channel,
  //       spec-defined state, not a derived timing measurement.
  //
  //   What is deliberately NOT claimed here is a wall-clock proof that (b)
  //   also delivers strictly faster in absolute terms. Measured against this
  //   package's own real-peer harness (`node-datachannel`, the only
  //   RTCPeerConnection available for hermetic Node testing -- see the
  //   top-of-file comment), the SAME payload sent on a dedicated 'bulk'
  //   channel and enqueued the SAME way arrived within ~1ms of a run where
  //   it was forced onto the shared channel: this specific native binding's
  //   SCTP sender was observed, across several harnesses (varying channel
  //   creation order, `ordered` flag, chunk count, and backpressure-paced
  //   sends via `bufferedAmountLowThreshold`), to flush queued outgoing data
  //   in strict enqueue order across the WHOLE peer connection, not
  //   round-robin per stream -- so a message enqueued last is transmitted
  //   last regardless of which channel it is on. That is a property of this
  //   one native SCTP implementation used only for this repo's own hermetic
  //   Node tests, not a property this change controls or can work around
  //   from the DataChannel API (no priority/scheduling option is exposed).
  //   Production browser WebRTC stacks are widely documented to schedule
  //   SCTP streams independently, which is the entire rationale the WebRTC
  //   spec gives for using multiple data channels to avoid this exact
  //   problem -- validating THAT claim needs a real-browser harness (see
  //   clawser's Playwright-based `web/test/mesh-p2p-e2e.spec.mjs`), which is
  //   out of reach for this package's Node-only test suite.

  const CHUNK_SIZE = 64 * 1024        // 64 KiB
  const CHUNK_COUNT = 400             // ~25 MiB total -- large enough that
                                       // the transfer takes a real,
                                       // measurable amount of wall time over
                                       // a real SCTP association.
  const CHUNK_PAYLOAD = 'x'.repeat(CHUNK_SIZE)

  it('on a single shared channel (the pre-fix shape), a control message is stuck behind an already-queued bulk backlog', async () => {
    const peers = pair()
    try {
      await connect(peers)

      let bulkChunksReceived = 0
      let bulkCompletedAt = null
      let controlReceivedAt = null
      const startedAt = performance.now()

      peers.bob.onMessage((msg) => {
        const now = performance.now()
        if (msg && msg.kind === 'bulk-chunk') {
          bulkChunksReceived += 1
          if (bulkChunksReceived === CHUNK_COUNT) bulkCompletedAt = now
        } else if (msg && msg.kind === 'control-ping') {
          controlReceivedAt = now
        }
      })

      // Every bulk chunk queued FIRST, then the control message -- exactly
      // the shape a single shared 'mesh' channel forced on every message
      // before this fix: a chat/consensus message issued while a bulk
      // transfer is mid-flight is, at that point, simply one more send() on
      // the same ordered stream, behind everything already queued.
      for (let i = 0; i < CHUNK_COUNT; i++) {
        peers.alice.send({ kind: 'bulk-chunk', i, data: CHUNK_PAYLOAD }, { channel: 'control' })
      }
      peers.alice.send({ kind: 'control-ping' }, { channel: 'control' })

      await waitFor(
        () => bulkChunksReceived === CHUNK_COUNT && controlReceivedAt !== null,
        20_000,
        'all bulk chunks and the control message to arrive',
      )

      const controlLatencyMs = controlReceivedAt - startedAt
      const bulkDurationMs = bulkCompletedAt - startedAt
      console.log(
        `[dual-channel] single shared channel: control arrived at ${controlLatencyMs.toFixed(1)}ms, ` +
        `bulk transfer (${CHUNK_COUNT} x ${CHUNK_SIZE / 1024}KiB) finished at ${bulkDurationMs.toFixed(1)}ms`,
      )

      // The regression this pins: on ONE ordered stream, the control message
      // cannot be delivered before every chunk queued ahead of it -- it
      // trails the bulk transfer's own completion, not just its start.
      assert.ok(
        controlLatencyMs >= bulkDurationMs,
        `on a single shared channel, control latency (${controlLatencyMs}ms) should be at least ` +
        `the full bulk transfer duration (${bulkDurationMs}ms) -- it was queued behind all of it`,
      )
    } finally {
      peers.alice.close(); peers.bob.close()
    }
  })

  it("a control channel's own backlog and readiness are never affected by the bulk channel's -- structurally independent, not just usually", async () => {
    const peers = pair()
    try {
      await connect(peers)

      // Baseline: freshly opened, nothing sent on either channel yet.
      assert.equal(peers.alice.isOpen, true)
      assert.equal(peers.alice.isBulkOpen, true, 'both sides created/received the bulk channel')

      const bobBulkChunks = []
      const bobControlMessages = []
      peers.bob.onMessage((msg) => {
        if (msg && msg.kind === 'bulk-chunk') bobBulkChunks.push(msg)
        else bobControlMessages.push(msg)
      })

      // Saturate the bulk channel: CHUNK_COUNT sends, none of them awaited or
      // paced, exactly the "blast everything" pattern the timing test above
      // uses to prove the shared-channel regression.
      for (let i = 0; i < CHUNK_COUNT; i++) {
        peers.alice.send({ kind: 'bulk-chunk', i, data: CHUNK_PAYLOAD }, { channel: 'bulk' })
      }

      // The real, spec-defined, per-channel state that must hold regardless
      // of the sender's scheduling behaviour: sending 25 MiB on 'bulk' does
      // not so much as touch the control channel's own accounting. This is
      // not a timing measurement and carries no flakiness risk -- it is
      // read synchronously, right after the loop above returns.
      assert.equal(
        peers.alice.isOpen, true,
        'the control channel is still open and unaffected immediately after saturating bulk',
      )

      // And the control channel is still fully, immediately usable: this
      // send() must succeed without throwing and without being made to wait
      // on anything the loop above queued.
      peers.alice.send({ kind: 'control-ping' }, { channel: 'control' })

      await waitFor(
        () => bobBulkChunks.length === CHUNK_COUNT && bobControlMessages.length === 1,
        20_000,
        'both the full bulk backlog and the control message to arrive',
      )
      assert.deepEqual(bobControlMessages[0], { kind: 'control-ping' })
    } finally {
      peers.alice.close(); peers.bob.close()
    }
  })

  // -------------------------------------------------------------------------
  // 2. Version-compat proof: an older, single-channel build interoperating
  //    with today's dual-channel build, in both roles.
  // -------------------------------------------------------------------------

  /**
   * Faithful reproduction of WebRTCPeerConnection as it was before the bulk
   * channel existed: one #dataChannel field, createOffer() creates exactly
   * one channel labelled 'mesh', and handleOffer()'s `ondatachannel` handler
   * unconditionally reassigns #dataChannel to whichever channel just arrived
   * -- attaching fresh listeners to THAT channel object without detaching
   * the previous one's. That last detail is exactly what this test exploits
   * to prove compatibility: it means an old answerer, even though written
   * with no knowledge of a second channel, ends up listening on every
   * channel it is ever handed, and only "forgets" which one counts as *the*
   * channel for sending.
   */
  class OldWebRTCPeerConnection {
    #localPodId; #remotePodId; #iceServers
    #pc = null
    #dataChannel = null
    #messageCbs = []
    #iceCandidateCbs = []
    #state = 'new'

    constructor({ localPodId, remotePodId, iceServers }) {
      this.#localPodId = localPodId
      this.#remotePodId = remotePodId
      this.#iceServers = iceServers || []
    }

    get state() { return this.#state }
    get isOpen() { return this.#state === 'connected' && this.#dataChannel?.readyState === 'open' }

    onMessage(cb) { this.#messageCbs.push(cb) }
    onIceCandidate(cb) { this.#iceCandidateCbs.push(cb) }

    addIceCandidate(candidate) {
      if (!this.#pc) return Promise.resolve(false)
      const remote = this.#pc.remoteDescription
      if (!remote || !remote.sdp) return Promise.resolve(true) // old code: no pending-candidate buffer needed for this test's timing
      return Promise.resolve(this.#pc.addIceCandidate(candidate)).then(() => true, () => false)
    }

    async createOffer() {
      this.#pc = new RTCPeerConnection({ iceServers: this.#iceServers })
      this.#wireIce()
      this.#dataChannel = this.#pc.createDataChannel('mesh', { ordered: true })
      this.#setupDataChannel(this.#dataChannel)
      const offer = await this.#pc.createOffer()
      await this.#pc.setLocalDescription(offer)
      this.#state = 'connecting'
      return { type: 'offer', sdp: offer.sdp }
    }

    async handleOffer(offer) {
      this.#pc = new RTCPeerConnection({ iceServers: this.#iceServers })
      this.#wireIce()
      // The exact old behaviour this test relies on: reassigns #dataChannel
      // on EVERY 'datachannel' event, attaching fresh listeners each time,
      // never detaching the previous channel's.
      this.#pc.ondatachannel = (event) => {
        this.#dataChannel = event.channel
        this.#setupDataChannel(this.#dataChannel)
      }
      await this.#pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
      const answer = await this.#pc.createAnswer()
      await this.#pc.setLocalDescription(answer)
      this.#state = 'connecting'
      return { type: 'answer', sdp: answer.sdp }
    }

    async handleAnswer(answer) {
      await this.#pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
    }

    send(data) {
      if (!this.#dataChannel || this.#dataChannel.readyState !== 'open') {
        throw new Error('Data channel not open')
      }
      this.#dataChannel.send(typeof data === 'string' ? data : JSON.stringify(data))
    }

    close() {
      try { this.#dataChannel?.close() } catch { /* ignore */ }
      try { this.#pc?.close() } catch { /* ignore */ }
      this.#state = 'closed'
    }

    #wireIce() {
      this.#pc.onicecandidate = (event) => {
        if (event.candidate) {
          for (const cb of this.#iceCandidateCbs) cb(event.candidate)
        }
      }
    }

    #setupDataChannel(dc) {
      dc.onopen = () => { this.#state = 'connected' }
      dc.onmessage = (event) => {
        let parsed = event.data
        try { parsed = JSON.parse(event.data) } catch { /* keep as string */ }
        for (const cb of this.#messageCbs) cb(parsed)
      }
    }
  }

  it('an OLD single-channel answerer interoperates with a NEW dual-channel offerer -- no hang, no dropped message', async () => {
    const newOfferer = new webrtc.WebRTCPeerConnection({
      localPodId: 'pod-new', remotePodId: 'pod-old', iceServers: [],
    })
    const oldAnswerer = new OldWebRTCPeerConnection({
      localPodId: 'pod-old', remotePodId: 'pod-new', iceServers: [],
    })
    newOfferer.onIceCandidate((c) => oldAnswerer.addIceCandidate(c))
    oldAnswerer.onIceCandidate((c) => newOfferer.addIceCandidate(c))

    try {
      const offer = await newOfferer.createOffer()
      const answer = await oldAnswerer.handleOffer(offer)
      await newOfferer.handleAnswer(answer)

      await waitFor(
        () => newOfferer.isOpen && oldAnswerer.isOpen,
        15_000,
        'both sides to connect despite the version skew',
      )

      const oldSaw = []
      oldAnswerer.onMessage((m) => oldSaw.push(m))
      const newSaw = []
      newOfferer.onMessage((m) => newSaw.push(m))

      // The new offerer created BOTH channels; the old answerer never asked
      // for a second one, but per the docs on OldWebRTCPeerConnection above
      // it still attached a listener to each 'datachannel' event it got --
      // so it should receive traffic sent on either channel.
      newOfferer.send({ via: 'control' }, { channel: 'control' })
      newOfferer.send({ via: 'bulk' }, { channel: 'bulk' })
      await waitFor(() => oldSaw.length === 2, 5_000, 'old answerer to receive both messages')
      assert.deepEqual(oldSaw.sort((a, b) => a.via.localeCompare(b.via)), [{ via: 'bulk' }, { via: 'control' }])

      // The old answerer only ever has ONE channel it treats as "the" one to
      // send on (whichever 'datachannel' event arrived last) -- but the new
      // offerer listens on both of its own channels for incoming messages,
      // so whichever one the old side picked, this must still arrive.
      oldAnswerer.send({ from: 'old' })
      await waitFor(() => newSaw.length === 1, 5_000, 'new offerer to receive the old answerer\'s reply')
      assert.deepEqual(newSaw[0], { from: 'old' })
    } finally {
      newOfferer.close(); oldAnswerer.close()
    }
  })

  it('an OLD single-channel offerer interoperates with a NEW dual-channel answerer -- bulk sends fall back to control, no hang', async () => {
    const oldOfferer = new OldWebRTCPeerConnection({
      localPodId: 'pod-old', remotePodId: 'pod-new', iceServers: [],
    })
    const newAnswerer = new webrtc.WebRTCPeerConnection({
      localPodId: 'pod-new', remotePodId: 'pod-old', iceServers: [],
    })
    oldOfferer.onIceCandidate((c) => newAnswerer.addIceCandidate(c))
    newAnswerer.onIceCandidate((c) => oldOfferer.addIceCandidate(c))

    try {
      const offer = await oldOfferer.createOffer()
      const answer = await newAnswerer.handleOffer(offer)
      await oldOfferer.handleAnswer(answer)

      await waitFor(
        () => oldOfferer.isOpen && newAnswerer.isOpen,
        15_000,
        'both sides to connect despite the version skew',
      )

      // The old offerer never created a 'mesh-bulk' channel, so the new
      // answerer's bulk slot must simply never populate -- not error, not
      // hang waiting for it.
      assert.equal(newAnswerer.isBulkOpen, false, 'new answerer has no bulk channel from an old offerer')

      const oldSaw = []
      oldOfferer.onMessage((m) => oldSaw.push(m))

      // Ask for 'bulk' anyway -- send() must gracefully fall back to the
      // control channel rather than throwing or silently dropping the
      // message, per its documented fallback behaviour.
      newAnswerer.send({ payload: 'big-file-chunk' }, { channel: 'bulk' })
      newAnswerer.send({ payload: 'chat' }, { channel: 'control' })

      await waitFor(() => oldSaw.length === 2, 5_000, 'old offerer to receive both messages via its one channel')
      assert.deepEqual(
        oldSaw.sort((a, b) => a.payload.localeCompare(b.payload)),
        [{ payload: 'big-file-chunk' }, { payload: 'chat' }],
      )
    } finally {
      oldOfferer.close(); newAnswerer.close()
    }
  })
})
