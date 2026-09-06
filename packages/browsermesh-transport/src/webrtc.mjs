/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-webrtc.js -- WebRTC mesh transport.
 *
 * Provides WebRTC DataChannel-based P2P connections for the BrowserMesh.
 * Includes signaling helpers, connection management, and a transport
 * adapter that integrates with MeshTransportNegotiator.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-webrtc.test.mjs
 */

import { MeshTransport } from './transport.mjs'
import { silentCatch } from './silent-catch.mjs'

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the current environment supports WebRTC.
 * @returns {boolean}
 */
export function supportsWebRTC() {
  return typeof RTCPeerConnection !== 'undefined'
}

/**
 * Extract the session id from an SDP's `o=` (origin) line.
 *
 * RFC 4566 gives the origin line as
 * `o=<username> <sess-id> <sess-version> <nettype> <addrtype> <address>`,
 * and RFC 3264 requires a follow-up offer for an existing session to reuse
 * that `<sess-id>`. So two offers carrying the same session id came from the
 * same peer connection, and an offer whose session id differs from the one
 * already applied is a *new* session -- the peer restarted.
 *
 * Used only as a fallback when the signaling payload lacks the explicit
 * `renegotiation` flag (see `handleOffer`), so that a peer running an older
 * build of this class can still be renegotiated with.
 *
 * @param {string} sdp
 * @returns {string|null} The session id, or null if the SDP has no origin line.
 */
export function sdpSessionId(sdp) {
  const m = /^o=\S+ (\S+) /m.exec(sdp || '')
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// ICE defaults
// ---------------------------------------------------------------------------

/**
 * Default ICE configuration: none.
 *
 * With no ICE servers a peer gathers host candidates only, which is all two
 * devices on the same LAN need and involves no third party. Contacting a
 * public STUN server discloses the client's public IP, and the fact that it
 * is pairing, to whoever runs it — so that is opt-in, not the default. See
 * PUBLIC_STUN_SERVERS to opt in, or supply your own STUN/TURN.
 *
 * @type {RTCIceServer[]}
 */
export const DEFAULT_ICE_SERVERS = Object.freeze([])

/**
 * A public STUN server, for callers who need reflexive candidates to traverse
 * NAT and have decided that the disclosure is acceptable.
 *
 * Using this sends a STUN binding request to Google from every peer that
 * gathers candidates, revealing the device's public IP address and the timing
 * of the pairing attempt. Prefer a STUN server you control.
 *
 * @type {RTCIceServer[]}
 */
export const PUBLIC_STUN_SERVERS = Object.freeze([
  { urls: 'stun:stun.l.google.com:19302' },
])

/**
 * Merge user-configured ICE servers (typically TURN, for NAT traversal
 * when direct/STUN connectivity fails) with the defaults. Silently
 * ignores malformed entries rather than throwing, since this is usually
 * fed by user-editable settings.
 *
 * An explicit empty array means "no ICE servers" and is honoured as given:
 * `mergeIceServers([])` returns `[]`, never the defaults. Omitting the
 * argument (or passing null) is what asks for the defaults.
 *
 * @param {RTCIceServer[]} [userServers] - e.g. [{urls: 'turn:relay.example.com', username, credential}]
 * @param {RTCIceServer[]} [defaults=DEFAULT_ICE_SERVERS]
 * @returns {RTCIceServer[]}
 */
export function mergeIceServers(userServers, defaults = DEFAULT_ICE_SERVERS) {
  // An explicit [] is a decision, not an absence. Respect it.
  if (Array.isArray(userServers) && userServers.length === 0) return []
  const valid = (Array.isArray(userServers) ? userServers : [])
    .filter(s => s && typeof s === 'object' && typeof s.urls === 'string' && s.urls.length > 0)
  return [...defaults, ...valid]
}

// ---------------------------------------------------------------------------
// WebRTCPeerConnection
// ---------------------------------------------------------------------------

/**
 * Manages a single WebRTC peer connection with a DataChannel.
 *
 * Lifecycle:
 *   1. Caller side:  createOffer() -> send offer via signaling -> handleAnswer()
 *   2. Callee side:  handleOffer(offer) -> send answer via signaling
 *   3. Both sides:   exchange ICE candidates via onIceCandidate / addIceCandidate
 *   4. DataChannel opens -> state becomes 'connected'
 *   5. close() tears down everything
 */
export class WebRTCPeerConnection {
  #localPodId
  #remotePodId
  #pc = null
  #dataChannel = null
  #iceServers
  #onLog
  #state = 'new'   // new | connecting | connected | closed
  #closing = false // reentrancy guard for close(); see close()
  #iceCandidateCbs = []
  #messageCbs = []
  #closeCbs = []
  #errorCbs = []
  #stateChangeCbs = []
  #stats = { bytesSent: 0, bytesReceived: 0, messagesIn: 0, messagesOut: 0 }
  #disconnectedGraceMs
  #disconnectedTimer = null

  /**
   * @param {object} opts
   * @param {string} opts.localPodId  - This pod's identifier
   * @param {string} opts.remotePodId - Target pod's identifier
   * @param {RTCIceServer[]} [opts.iceServers]
   * @param {Function} [opts.onLog]   - Optional logging callback
   * @param {number} [opts.disconnectedGraceMs=5000] - How long a peer connection
   *   may sit in the transient `disconnected` state before it is reported
   *   through `onError()`. `failed` is reported immediately and is not
   *   subject to this delay.
   */
  constructor({ localPodId, remotePodId, iceServers, onLog, disconnectedGraceMs = 5000 } = {}) {
    if (!localPodId) throw new Error('localPodId is required')
    if (!remotePodId) throw new Error('remotePodId is required')
    this.#localPodId = localPodId
    this.#remotePodId = remotePodId
    this.#iceServers = iceServers || [...DEFAULT_ICE_SERVERS]
    this.#onLog = onLog || null
    this.#disconnectedGraceMs = disconnectedGraceMs
  }

  // -- Accessors ------------------------------------------------------------

  /** Local pod identifier. */
  get localPodId() { return this.#localPodId }

  /** Remote pod identifier. */
  get remotePodId() { return this.#remotePodId }

  /** Current connection state. */
  get state() { return this.#state }

  /** Byte-level stats (copy). */
  get stats() { return { ...this.#stats } }

  /** True when the DataChannel is open and usable. */
  get isOpen() {
    return this.#state === 'connected' &&
           this.#dataChannel?.readyState === 'open'
  }

  // -- Offer / Answer -------------------------------------------------------

  /**
   * Create an SDP offer (caller side).
   * Sets up the RTCPeerConnection, creates a DataChannel, and returns
   * the offer to be sent through signaling.
   *
   * @returns {Promise<{type: 'offer', sdp: string}>}
   */
  async createOffer() {
    this.#ensureNotClosed()
    this.#pc = new RTCPeerConnection({ iceServers: this.#iceServers })
    this.#setupIceHandling()
    this.#setupConnectionStateHandling()

    this.#dataChannel = this.#pc.createDataChannel('mesh', {
      ordered: true,
    })
    this.#setupDataChannel(this.#dataChannel)

    const offer = await this.#pc.createOffer()
    await this.#pc.setLocalDescription(offer)
    this.#setState('connecting')
    this.#log(`Created offer for ${this.#remotePodId}`)
    return { type: 'offer', sdp: offer.sdp }
  }

  /**
   * Handle an incoming SDP offer (callee side) and return the answer to send
   * back through signaling.
   *
   * Two different things arrive here, and telling them apart is the whole
   * point of the `renegotiation` flag:
   *
   * - A **fresh** offer starts a new session. A new RTCPeerConnection is
   *   built for it, replacing (and releasing) any connection we already had
   *   with this peer -- which is the right response to a peer that restarted.
   *
   * - A **renegotiation** offer -- an ICE restart, or any other mid-session
   *   re-offer -- must be applied to the *existing* RTCPeerConnection. It has
   *   to be: the answer carries this side's ICE credentials and DTLS
   *   fingerprint, and a renegotiation whose answer changes either of those
   *   is rejected by the offerer. Building a new connection here is what
   *   issue #13 measured, and it killed both peers:
   *   `libdatachannel error while adding remote description: Invalid ICE
   *   settings from remote SDP`.
   *
   * `offer.renegotiation === true` is the marker on the wire. It is a plain
   * extra field on the same JSON payload the offer already is, so a peer that
   * does not understand it simply ignores it and behaves exactly as it does
   * today. For a sender too old to set it, `#isRenegotiation()` falls back to
   * comparing SDP session ids, which recovers the same answer without any
   * cooperation from the sender.
   *
   * @param {{type: string, sdp: string, renegotiation?: boolean}} offer
   * @returns {Promise<{type: 'answer', sdp: string, renegotiation?: boolean}>}
   * @throws {Error} If the offer is a renegotiation but there is no live
   *   connection to renegotiate -- the sender must start a fresh one.
   */
  async handleOffer(offer) {
    this.#ensureNotClosed()
    if (!offer || !offer.sdp) throw new Error('Invalid offer: missing sdp')

    if (this.#isRenegotiation(offer)) {
      if (!this.#pc) {
        throw new Error(
          'Cannot answer a renegotiation offer: no existing connection — the peer must send a fresh offer',
        )
      }
      // Deliberately no #setState() and no new handlers: a renegotiation
      // keeps the DataChannel, the callbacks and the transport state it
      // already has. Data keeps flowing over the old path until the new one
      // is nominated -- that is what makes an ICE restart a repair rather
      // than a reconnection.
      await this.#pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
      const answer = await this.#pc.createAnswer()
      await this.#pc.setLocalDescription(answer)
      this.#log(`Created renegotiation answer for ${this.#remotePodId}`)
      return { type: 'answer', sdp: answer.sdp, renegotiation: true }
    }

    // A fresh offer supersedes anything we were holding. Release it rather
    // than overwriting the field: the old RTCPeerConnection is otherwise
    // unreachable and, with a native stack, keeps threads and sockets alive.
    this.#releasePeerConnection()

    this.#pc = new RTCPeerConnection({ iceServers: this.#iceServers })
    this.#setupIceHandling()
    this.#setupConnectionStateHandling()

    this.#pc.ondatachannel = (event) => {
      this.#dataChannel = event.channel
      this.#setupDataChannel(this.#dataChannel)
    }

    await this.#pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
    const answer = await this.#pc.createAnswer()
    await this.#pc.setLocalDescription(answer)
    this.#setState('connecting')
    this.#log(`Created answer for ${this.#remotePodId}`)
    return { type: 'answer', sdp: answer.sdp }
  }

  /**
   * Apply the remote SDP answer (caller side, after receiving answer).
   *
   * @param {{type: string, sdp: string}} answer
   */
  async handleAnswer(answer) {
    if (!this.#pc) throw new Error('No peer connection — call createOffer() first')
    if (!answer || !answer.sdp) throw new Error('Invalid answer: missing sdp')
    await this.#pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
    this.#log(`Applied answer from ${this.#remotePodId}`)
  }

  // -- ICE ------------------------------------------------------------------

  /**
   * Add a remote ICE candidate received through signaling.
   *
   * `RTCPeerConnection.addIceCandidate()` is asynchronous and rejects on a
   * malformed candidate, on a candidate for an m-line that does not exist,
   * and on any candidate that arrives before the remote description is set.
   * All three are ordinary events on a real signaling channel -- candidates
   * race the answer, and the string on the wire came from another machine --
   * and this method used to drop that promise on the floor. An unhandled
   * rejection terminates a Node process by default and raises an uncaught
   * error event in a browser, so one bad candidate from a peer could take the
   * process down. Verified against two real RTCPeerConnections; see
   * `test/real-peer/webrtc.test.mjs`.
   *
   * A rejected candidate is not a connection failure: ICE is designed to try
   * many candidates and keep the ones that work. It is therefore logged and
   * swallowed rather than routed to `onError()`, which WebRTCMeshManager wires
   * to its reconnect backoff -- a peer sending junk candidates should not be
   * able to force ICE restarts.
   *
   * @param {RTCIceCandidate|object} candidate
   * @returns {Promise<boolean>} Resolves true if the candidate was accepted,
   *   false if it was rejected. Never rejects.
   * @throws {Error} Synchronously, if there is no peer connection yet.
   */
  addIceCandidate(candidate) {
    if (!this.#pc) throw new Error('No peer connection')
    return Promise.resolve(this.#pc.addIceCandidate(candidate)).then(
      () => true,
      (err) => {
        this.#log(`Ignored ICE candidate from ${this.#remotePodId}: ${err?.message || err}`)
        return false
      },
    )
  }

  /**
   * Register callback for locally-gathered ICE candidates.
   * These must be sent to the remote peer through signaling.
   *
   * @param {Function} cb - Called with (candidate: RTCIceCandidate)
   */
  onIceCandidate(cb) {
    this.#iceCandidateCbs.push(cb)
  }

  // -- Messaging ------------------------------------------------------------

  /**
   * Register a callback for incoming DataChannel messages.
   * JSON strings are automatically parsed.
   *
   * @param {Function} cb
   */
  onMessage(cb) { this.#messageCbs.push(cb) }

  /**
   * Register a callback for connection close.
   *
   * @param {Function} cb
   */
  onClose(cb) { this.#closeCbs.push(cb) }

  /**
   * Register a callback for connection errors.
   *
   * @param {Function} cb
   */
  onError(cb) { this.#errorCbs.push(cb) }

  /**
   * Register a callback for every connection state transition
   * (new/connecting/connected/closed). Used by WebRTCMeshManager's
   * reconnect-backoff logic to detect recovery, and by the mesh health
   * dashboard to track connectivity.
   *
   * @param {Function} cb - Called with (state: string)
   */
  onStateChange(cb) { this.#stateChangeCbs.push(cb) }

  /**
   * Send data over the DataChannel.
   * Objects are JSON-serialized automatically.
   *
   * @param {string|object} data
   */
  send(data) {
    if (!this.#dataChannel) throw new Error('No data channel')
    if (this.#dataChannel.readyState !== 'open') {
      throw new Error('Data channel not open')
    }
    const str = typeof data === 'string' ? data : JSON.stringify(data)
    this.#dataChannel.send(str)
    this.#stats.bytesSent += str.length
    this.#stats.messagesOut += 1
  }

  /**
   * Attempt to recover a failed/disconnected connection via ICE restart.
   * Only valid once an underlying RTCPeerConnection exists (i.e. after
   * createOffer() or handleOffer() has run at least once) — generates a
   * renegotiation offer on the *existing* connection with `iceRestart: true`.
   *
   * **A healthy connection is left alone.** This used to flip the state to
   * `connecting` as its first act, so calling it on a working connection made
   * `isOpen` false — and `broadcast()` skips a peer that is not open — before
   * anything had gone wrong. It now returns `null` and touches nothing.
   * `{ force: true }` overrides that for a caller who knows something the
   * connection state does not (a changed network interface, say). The state
   * is never moved from here at all: a renegotiation does not interrupt the
   * DataChannel, and the state machine is driven by the channel's own events.
   *
   * It also declines while a negotiation is already in flight
   * (`signalingState !== 'stable'`), so a retry loop cannot stack offers on
   * top of each other.
   *
   * Known limitation: if the answer to a renegotiation offer never comes
   * back, the connection stays in `have-local-offer` and every later
   * `reconnect()` declines. Recovering from that needs a rollback
   * (`setLocalDescription({type: 'rollback'})`), which libdatachannel does
   * not implement, so it is not attempted here. In practice the peer
   * connection reaches `failed` on its own and the connection is torn down;
   * the visible symptom until then is a peer that stops being repaired.
   *
   * ICE restart still requires a full signaling round-trip: the caller must
   * send the returned offer through the same external signaling channel used
   * originally, and route the answer back via handleAnswer() as usual. The
   * offer carries `renegotiation: true` so the receiving peer answers on its
   * existing connection instead of building a new one — without that marker
   * the answer comes back with a different DTLS fingerprint and is rejected.
   * This class doesn't own signaling — see WebRTCMeshManager.onReconnectOffer()
   * for the orchestrated version.
   *
   * Whether the ICE credentials actually change is up to the underlying
   * stack. Browsers mint new ones for `iceRestart: true`; libdatachannel
   * currently ignores the flag and `restartIce()` throws `Not implemented`
   * there. The renegotiation round-trip below is correct either way — on a
   * stack without ICE restart it re-runs connectivity checks over the same
   * credentials, which is strictly better than the connection teardown it
   * replaces.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.force=false] - Renegotiate even if the connection
   *   currently looks healthy.
   * @returns {Promise<{type: 'offer', sdp: string, renegotiation: true}|null>}
   *   null when there is nothing to repair, or a negotiation is already
   *   in flight.
   * @throws {Error} If there's no underlying connection yet, or it's closed
   */
  async reconnect({ force = false } = {}) {
    this.#ensureNotClosed()
    if (!this.#pc) throw new Error('Cannot reconnect: no underlying connection — call createOffer() first')

    const signalingState = this.#pc.signalingState
    if (signalingState !== undefined && signalingState !== 'stable') {
      this.#log(`ICE restart for ${this.#remotePodId} skipped: negotiation already in flight (${signalingState})`)
      return null
    }
    if (!force && this.#isHealthy()) {
      this.#log(`ICE restart for ${this.#remotePodId} skipped: connection is healthy`)
      return null
    }

    const offer = await this.#pc.createOffer({ iceRestart: true })
    await this.#pc.setLocalDescription(offer)
    this.#log(`ICE restart offer created for ${this.#remotePodId}`)
    return { type: 'offer', sdp: offer.sdp, renegotiation: true }
  }

  /**
   * Query real-time connection health via `RTCPeerConnection.getStats()`.
   * Data channels don't expose a standard `packetsLost` counter the way
   * RTP media tracks do (there's no media here), so `packetLossRatio` is
   * an approximation derived from the nominated candidate pair's STUN
   * connectivity-check retransmission ratio — a reasonable proxy for
   * path quality, not an exact application-level loss count.
   *
   * @returns {Promise<{remotePodId: string, state: string, bytesSent: number,
   *   bytesReceived: number, messagesSent: number, messagesReceived: number,
   *   roundTripTime: number|null, packetLossRatio: number}>}
   * @throws {Error} If there's no underlying connection yet.
   */
  async getConnectionStats() {
    if (!this.#pc) throw new Error('Cannot get stats: no peer connection — call createOffer() first')
    const report = await this.#pc.getStats()
    let bytesSent = 0, bytesReceived = 0, messagesSent = 0, messagesReceived = 0
    let roundTripTime = null, requestsSent = 0, responsesReceived = 0
    for (const stat of report.values()) {
      if (stat.type === 'data-channel') {
        bytesSent += stat.bytesSent || 0
        bytesReceived += stat.bytesReceived || 0
        messagesSent += stat.messagesSent || 0
        messagesReceived += stat.messagesReceived || 0
      } else if (stat.type === 'candidate-pair' && stat.nominated) {
        if (typeof stat.currentRoundTripTime === 'number') roundTripTime = stat.currentRoundTripTime
        requestsSent += stat.requestsSent || 0
        responsesReceived += stat.responsesReceived || 0
      }
    }
    const packetLossRatio = requestsSent > 0 ? Math.max(0, 1 - responsesReceived / requestsSent) : 0
    return {
      remotePodId: this.#remotePodId,
      state: this.#state,
      bytesSent, bytesReceived, messagesSent, messagesReceived,
      roundTripTime,
      packetLossRatio,
    }
  }

  /**
   * Close the connection and clean up all resources.
   */
  close() {
    const alreadyClosed = this.#state === 'closed'

    // Release the underlying objects unconditionally, even when the state is
    // already 'closed'. It used to return early on that check, which meant a
    // connection closed *by the remote peer* -- where the DataChannel's
    // onclose set the state before anyone released anything -- kept its
    // RTCPeerConnection forever. That is one leaked peer connection per
    // remote disconnect, and with a real WebRTC stack it also keeps the
    // process alive: a Node test that connected two real peers and let one
    // hang up would never exit. Verified against two real
    // RTCPeerConnections; see test/real-peer/webrtc.test.mjs.
    // Releasing the DataChannel fires its onclose, and onclose routes back
    // into close() -- that is how a remote hangup releases our peer
    // connection. Re-entering here before #setState('closed') has run means
    // the guard in onclose still sees a live state, so close() calls itself
    // until the stack runs out. The RangeError is then swallowed by the
    // release try/catch below, so the symptom is not a crash but a *missing*
    // 'closed' transition, appearing only on whichever runs exhaust the stack
    // inside #setState's callback loop. Measured at 2227 frames deep.
    //
    // Browsers dispatch onclose asynchronously, which is why this hides in a
    // real browser and surfaces against a synchronous mock or binding.
    if (this.#closing) return
    this.#closing = true
    try {
      if (this.#dataChannel) {
        try { this.#dataChannel.close() } catch (e) { silentCatch('clawser-mesh-webrtc', 'this', e) }
        this.#dataChannel = null
      }
      if (this.#pc) {
        try { this.#pc.close() } catch (e) { silentCatch('clawser-mesh-webrtc', 'this', e) }
        this.#pc = null
      }
    } finally {
      this.#closing = false
    }

    // The state transition and the close callbacks fire exactly once, so a
    // second close() -- or a close() following a remote hangup -- is silent.
    if (alreadyClosed) return
    this.#setState('closed')
    this.#fireClose()
    this.#log(`Connection closed with ${this.#remotePodId}`)
  }

  // -- Internal helpers -----------------------------------------------------

  #ensureNotClosed() {
    if (this.#state === 'closed') {
      throw new Error('Connection is closed')
    }
  }

  /**
   * Is this offer a re-offer on the connection we already have?
   *
   * The explicit flag is authoritative in both directions, so a sender can
   * also assert `renegotiation: false`. Absent the flag, fall back to the
   * SDP session id: RFC 3264 requires a re-offer to reuse the `o=` session id
   * of the session it updates, so an offer matching the description already
   * applied is a re-offer and one that differs is a new session. That
   * fallback is what makes a peer running an older build -- one that cannot
   * set the flag -- renegotiable rather than fatal.
   */
  #isRenegotiation(offer) {
    if (offer.renegotiation === true) return true
    if (offer.renegotiation === false) return false
    if (!this.#pc) return false
    const applied = this.#pc.remoteDescription?.sdp
    if (!applied) return false
    const incoming = sdpSessionId(offer.sdp)
    return incoming !== null && incoming === sdpSessionId(applied)
  }

  /**
   * A connection is healthy when our DataChannel is open *and* the peer
   * connection itself agrees. The second half matters: a peer connection can
   * report `failed` while the DataChannel has not yet noticed, and treating
   * that as healthy would refuse the very repair it needs. Stacks that do not
   * expose `connectionState` fall back to the DataChannel alone.
   */
  #isHealthy() {
    if (!this.isOpen) return false
    const pcState = this.#pc?.connectionState
    return pcState === undefined || pcState === 'connected'
  }

  /**
   * Drop the underlying RTCPeerConnection and DataChannel without announcing
   * a close. Handlers are detached first: closing a DataChannel fires its
   * `onclose`, which would otherwise report this connection as closed to
   * every listener -- including WebRTCMeshManager, which would delete it --
   * even though we are only swapping the transport underneath.
   */
  #releasePeerConnection() {
    const dc = this.#dataChannel
    const pc = this.#pc
    this.#dataChannel = null
    this.#pc = null
    if (dc) {
      dc.onopen = null; dc.onmessage = null; dc.onclose = null; dc.onerror = null
      try { dc.close() } catch (e) { silentCatch('clawser-mesh-webrtc', 'release-dc', e) }
    }
    if (pc) {
      pc.onicecandidate = null; pc.ondatachannel = null; pc.onconnectionstatechange = null
      try { pc.close() } catch (e) { silentCatch('clawser-mesh-webrtc', 'release-pc', e) }
    }
  }

  #setState(next) {
    if (this.#state === next) return
    if (next === 'closed') this.#clearDisconnectedGrace()
    this.#state = next
    for (const cb of this.#stateChangeCbs) {
      try { cb(next) } catch (e) { silentCatch('clawser-mesh-webrtc', 'swallow', e) }
    }
  }

  #setupIceHandling() {
    this.#pc.onicecandidate = (event) => {
      if (event.candidate) {
        for (const cb of this.#iceCandidateCbs) {
          try { cb(event.candidate) } catch (e) { silentCatch('clawser-mesh-webrtc', 'swallow', e) }
        }
      }
    }
  }

  /**
   * `failed` and `disconnected` are not the same event and must not be
   * reported the same way.
   *
   * `failed` is terminal: ICE has exhausted its candidate pairs. Report it at
   * once.
   *
   * `disconnected` means connectivity checks are currently failing. It is
   * transient by design and very often recovers on its own within a couple of
   * seconds -- a Wi-Fi roam, a dropped consent check. This used to be
   * reported as an error immediately, and WebRTCMeshManager wires `onError`
   * straight to its reconnect backoff, so an ordinary network blip triggered
   * a renegotiation on a connection that was in the middle of healing. It is
   * now reported only if it is *still* disconnected after
   * `disconnectedGraceMs`; any other state in the meantime cancels it.
   */
  #setupConnectionStateHandling() {
    this.#pc.onconnectionstatechange = () => {
      const pcState = this.#pc?.connectionState
      if (pcState === 'failed') {
        this.#clearDisconnectedGrace()
        this.#fireError(new Error('PeerConnection state: failed'))
        return
      }
      if (pcState === 'disconnected') {
        this.#startDisconnectedGrace()
        return
      }
      /*
       * `closed` arriving here means the STACK closed the connection, not us:
       * our own close() nulls `#pc` first, so this handler cannot see it.
       *
       * It was falling through to the line below and doing nothing, which
       * left a dead connection looking alive. Measured by corrupting one hex
       * pair of the DTLS fingerprint in the answer -- an answer that cannot
       * verify, which is what a corrupted or hostile one looks like:
       *
       *     t=   0ms  pc0[ice=checking conn=connecting]
       *     t=  52ms  pc0[ice=closed   conn=closed]      <- stack gave up
       *     t=12013ms  state=connecting  error=none      <- we never said so
       *
       * Twelve seconds after both peer connections had closed themselves,
       * `state` was still `connecting`, no error had fired, and no close
       * callback had run. A caller waiting on `isOpen` waits forever, and
       * WebRTCMeshManager -- which reconnects on `onError` -- never hears
       * anything to reconnect from.
       *
       * The DataChannel's own close path cannot cover this: the channel never
       * opened, so `dc.onclose` never fires.
       *
       * Reported as an error and then closed, which is the order `dc.onerror`
       * already uses, so a caller listening only for errors still learns the
       * cause before the terminal close.
       */
      if (pcState === 'closed' && this.#state !== 'closed') {
        this.#clearDisconnectedGrace()
        this.#fireError(new Error('PeerConnection closed before the DataChannel opened'))
        this.close()
        return
      }
      this.#clearDisconnectedGrace()
    }
  }

  #startDisconnectedGrace() {
    if (this.#disconnectedTimer) return
    this.#log(
      `PeerConnection with ${this.#remotePodId} is disconnected; ` +
      `allowing ${this.#disconnectedGraceMs}ms to recover`,
    )
    this.#disconnectedTimer = setTimeout(() => {
      this.#disconnectedTimer = null
      if (this.#state === 'closed') return
      if (this.#pc?.connectionState !== 'disconnected') return  // recovered
      this.#log(`PeerConnection with ${this.#remotePodId} stayed disconnected`)
      this.#fireError(new Error('PeerConnection state: disconnected'))
    }, this.#disconnectedGraceMs)
    // A pending grace period must never be the reason a Node process stays
    // alive; browsers have no unref() and do not need one.
    if (typeof this.#disconnectedTimer?.unref === 'function') this.#disconnectedTimer.unref()
  }

  #clearDisconnectedGrace() {
    if (!this.#disconnectedTimer) return
    clearTimeout(this.#disconnectedTimer)
    this.#disconnectedTimer = null
  }

  #setupDataChannel(dc) {
    dc.onopen = () => {
      this.#setState('connected')
      this.#log(`DataChannel open with ${this.#remotePodId}`)
    }
    dc.onmessage = (event) => {
      const rawLen = event.data?.length || 0
      this.#stats.bytesReceived += rawLen
      this.#stats.messagesIn += 1
      let parsed = event.data
      try { parsed = JSON.parse(event.data) } catch { /* keep as string */ }
      for (const cb of this.#messageCbs) {
        try { cb(parsed) } catch (e) { silentCatch('clawser-mesh-webrtc', 'swallow', e) }
      }
    }
    dc.onclose = () => {
      // The remote hung up. Go through close() rather than just flipping the
      // state, so our own RTCPeerConnection is released too.
      if (this.#state !== 'closed') this.close()
    }
    dc.onerror = (event) => {
      this.#fireError(event?.error || new Error('DataChannel error'))
      if (this.#state !== 'closed') {
        this.#setState('closed')
        this.#fireClose()
      }
    }
  }

  #fireClose() {
    for (const cb of this.#closeCbs) {
      try { cb() } catch (e) { silentCatch('clawser-mesh-webrtc', 'swallow', e) }
    }
  }

  #fireError(err) {
    for (const cb of this.#errorCbs) {
      try { cb(err) } catch (e) { silentCatch('clawser-mesh-webrtc', 'swallow', e) }
    }
  }

  #log(msg) {
    if (this.#onLog) this.#onLog(msg)
  }
}

// ---------------------------------------------------------------------------
// WebRTCMeshManager
// ---------------------------------------------------------------------------

/**
 * Manages multiple WebRTC peer connections indexed by remotePodId.
 * Thin orchestration layer — signaling is left to the caller.
 */
export class WebRTCMeshManager {
  #localPodId
  #iceServers
  #connections = new Map()   // remotePodId -> WebRTCPeerConnection
  #onLog
  #messageCbs = []
  #reconnectOfferCbs = []
  #reconnectAttempts = new Map()  // remotePodId -> count
  #reconnectTimers = new Map()    // remotePodId -> timer handle
  #maxReconnectAttempts
  #reconnectBaseDelayMs
  #disconnectedGraceMs
  #lastStats = []

  /**
   * @param {object} opts
   * @param {string} opts.localPodId
   * @param {RTCIceServer[]} [opts.iceServers]
   * @param {Function} [opts.onLog]
   * @param {number} [opts.maxReconnectAttempts=5] - Give up auto-reconnecting after this many failures
   * @param {number} [opts.reconnectBaseDelayMs=1000] - Backoff base; doubles each attempt
   * @param {number} [opts.disconnectedGraceMs=5000] - Passed to every connection:
   *   how long a peer connection may sit in the transient `disconnected` state
   *   before it counts as an error worth reconnecting over.
   */
  constructor({
    localPodId, iceServers, onLog,
    maxReconnectAttempts = 5, reconnectBaseDelayMs = 1000, disconnectedGraceMs = 5000,
  } = {}) {
    if (!localPodId) throw new Error('localPodId is required')
    this.#localPodId = localPodId
    this.#iceServers = iceServers || [...DEFAULT_ICE_SERVERS]
    this.#onLog = onLog || null
    this.#maxReconnectAttempts = maxReconnectAttempts
    this.#reconnectBaseDelayMs = reconnectBaseDelayMs
    this.#disconnectedGraceMs = disconnectedGraceMs
  }

  /** Local pod identifier. */
  get localPodId() { return this.#localPodId }

  /** Number of tracked connections. */
  get connectionCount() { return this.#connections.size }

  /**
   * Register a global message listener that fires for all connections.
   *
   * @param {Function} cb - Called with (data, remotePodId)
   */
  onMessage(cb) { this.#messageCbs.push(cb) }

  /**
   * Register a callback fired with a fresh ICE-restart offer whenever the
   * manager auto-retries a failed connection. The caller must forward
   * this offer through the same external signaling channel used for the
   * original connection.
   *
   * @param {Function} cb - Called with (offer: {type, sdp}, remotePodId: string)
   */
  onReconnectOffer(cb) { this.#reconnectOfferCbs.push(cb) }

  /**
   * Create or return an existing WebRTCPeerConnection for a remote pod.
   * Returns the same instance on duplicate calls with the same remotePodId.
   *
   * @param {string} remotePodId
   * @returns {Promise<WebRTCPeerConnection>}
   */
  async connectToPeer(remotePodId) {
    if (this.#connections.has(remotePodId)) {
      return this.#connections.get(remotePodId)
    }
    const conn = new WebRTCPeerConnection({
      localPodId: this.#localPodId,
      remotePodId,
      iceServers: this.#iceServers,
      onLog: this.#onLog,
      disconnectedGraceMs: this.#disconnectedGraceMs,
    })
    // Forward messages to manager-level listeners
    conn.onMessage((data) => {
      for (const cb of this.#messageCbs) {
        try { cb(data, remotePodId) } catch (e) { silentCatch('clawser-mesh-webrtc', 'swallow', e) }
      }
    })
    // Auto-remove on close
    conn.onClose(() => {
      this.#connections.delete(remotePodId)
      this.#clearReconnectState(remotePodId)
    })
    // Reset backoff once the connection actually recovers
    conn.onStateChange((state) => {
      if (state === 'connected') this.#clearReconnectState(remotePodId)
    })
    // Auto-retry with exponential backoff on failure/disconnect
    conn.onError(() => this.#scheduleReconnect(remotePodId, conn))
    this.#connections.set(remotePodId, conn)
    return conn
  }

  /**
   * Manually trigger reconnection for a peer (bypasses backoff).
   *
   * @param {string} remotePodId
   * @param {object} [opts]
   * @param {boolean} [opts.force=false] - Renegotiate even if the connection
   *   looks healthy. Without it a healthy connection is left alone.
   * @returns {Promise<{type: 'offer', sdp: string, renegotiation: true}|null>}
   *   null if there is no such connection, or nothing to repair.
   */
  async reconnectPeer(remotePodId, { force = false } = {}) {
    const conn = this.#connections.get(remotePodId)
    if (!conn) return null
    const offer = await conn.reconnect({ force })
    if (!offer) return null
    this.#notifyReconnectOffer(offer, remotePodId)
    return offer
  }

  #clearReconnectState(remotePodId) {
    this.#reconnectAttempts.delete(remotePodId)
    const timer = this.#reconnectTimers.get(remotePodId)
    if (timer) {
      clearTimeout(timer)
      this.#reconnectTimers.delete(remotePodId)
    }
  }

  #notifyReconnectOffer(offer, remotePodId) {
    for (const cb of this.#reconnectOfferCbs) {
      try { cb(offer, remotePodId) } catch (e) { silentCatch('clawser-mesh-webrtc', 'swallow', e) }
    }
  }

  #scheduleReconnect(remotePodId, conn) {
    if (this.#reconnectTimers.has(remotePodId)) return // already scheduled
    const attempts = this.#reconnectAttempts.get(remotePodId) || 0
    if (attempts >= this.#maxReconnectAttempts) {
      if (this.#onLog) this.#onLog(`Giving up reconnecting to ${remotePodId} after ${attempts} attempts`)
      return
    }
    const delay = this.#reconnectBaseDelayMs * (2 ** attempts)
    this.#reconnectAttempts.set(remotePodId, attempts + 1)
    const timer = setTimeout(async () => {
      this.#reconnectTimers.delete(remotePodId)
      if (!this.#connections.has(remotePodId)) return // closed/removed meanwhile
      try {
        const offer = await conn.reconnect()
        if (offer) {
          this.#notifyReconnectOffer(offer, remotePodId)
        } else {
          // Nothing was wrong with the connection after all -- the error that
          // scheduled this attempt was spurious, or it healed while we waited.
          // Refund the backoff rather than counting it against the peer.
          this.#clearReconnectState(remotePodId)
        }
      } catch (e) { silentCatch('clawser-mesh-webrtc', 'reconnect-attempt', e) }
    }, delay)
    this.#reconnectTimers.set(remotePodId, timer)
  }

  /**
   * Get an existing connection by remotePodId.
   *
   * @param {string} remotePodId
   * @returns {WebRTCPeerConnection|null}
   */
  getConnection(remotePodId) {
    return this.#connections.get(remotePodId) || null
  }

  /**
   * Check whether a connection to remotePodId exists.
   *
   * @param {string} remotePodId
   * @returns {boolean}
   */
  hasConnection(remotePodId) {
    return this.#connections.has(remotePodId)
  }

  /**
   * List all tracked connections with their current state.
   *
   * @returns {Array<{remotePodId: string, state: string}>}
   */
  listConnections() {
    return [...this.#connections.entries()].map(([remotePodId, conn]) => ({
      remotePodId,
      state: conn.state,
    }))
  }

  /**
   * Query `getConnectionStats()` on every tracked connection. A single
   * connection's stats query failing (e.g. mid-teardown) doesn't abort
   * the rest — its entry carries `error` instead. Result is cached on
   * `lastStats` for synchronous readers (e.g. MeshInspector.snapshot(),
   * which can't await this method).
   *
   * @returns {Promise<Array<object>>}
   */
  async getAllConnectionStats() {
    const results = []
    for (const [remotePodId, conn] of this.#connections.entries()) {
      try {
        results.push(await conn.getConnectionStats())
      } catch (err) {
        results.push({ remotePodId, state: conn.state, error: err?.message || String(err) })
      }
    }
    this.#lastStats = results
    return results
  }

  /**
   * The result of the most recent `getAllConnectionStats()` call, read
   * synchronously. Empty until the first call.
   * @returns {Array<object>}
   */
  get lastStats() { return this.#lastStats }

  /**
   * Broadcast data to all connected peers.
   *
   * @param {string|object} data
   * @returns {number} Number of peers the message was sent to
   */
  broadcast(data) {
    let sent = 0
    for (const conn of this.#connections.values()) {
      if (conn.isOpen) {
        try {
          conn.send(data)
          sent++
        } catch { /* skip failed sends */ }
      }
    }
    return sent
  }

  /**
   * Close a specific peer connection.
   *
   * @param {string} remotePodId
   * @returns {boolean} True if a connection was found and closed
   */
  closePeer(remotePodId) {
    const conn = this.#connections.get(remotePodId)
    if (!conn) return false
    conn.close()
    this.#connections.delete(remotePodId)
    return true
  }

  /**
   * Close all peer connections and clear internal state.
   */
  closeAll() {
    for (const conn of this.#connections.values()) {
      try { conn.close() } catch (e) { silentCatch('clawser-mesh-webrtc', 'conn.close', e) }
    }
    this.#connections.clear()
  }
}

// ---------------------------------------------------------------------------
// WebRTCTransportAdapter
// ---------------------------------------------------------------------------

/**
 * Wraps a WebRTCPeerConnection as a MeshTransport for use with
 * MeshTransportNegotiator. The connection negotiation (offer/answer/ICE)
 * happens externally; this adapter handles the send/close lifecycle.
 */
export class WebRTCTransportAdapter extends MeshTransport {
  #connection

  /**
   * @param {WebRTCPeerConnection} connection
   */
  constructor(connection) {
    super('webrtc')
    if (!connection) throw new Error('connection is required')
    this.#connection = connection

    // Forward messages from the underlying connection
    this.#connection.onMessage((data) => {
      this._fire('message', data)
    })
    this.#connection.onClose(() => {
      if (this.state !== 'closed') {
        this._setState('closed')
      }
    })
    this.#connection.onError((err) => {
      this._fire('error', err)
    })
  }

  /**
   * Mark transport as connected.
   * The actual WebRTC negotiation (offer/answer) happens outside this adapter.
   */
  async connect() {
    this._setState('connecting')
    this._setState('connected')
  }

  /**
   * Send data through the underlying WebRTC DataChannel.
   *
   * @param {string|object} data
   */
  send(data) {
    this.#connection.send(data)
  }

  /**
   * Close the underlying WebRTC connection.
   */
  close() {
    this.#connection.close()
    super.close()
  }

  /** The underlying WebRTCPeerConnection. */
  get peerConnection() { return this.#connection }
}

// ---------------------------------------------------------------------------
// WebRTCAdapterFactory
// ---------------------------------------------------------------------------

/**
 * Factory for creating WebRTC transports.
 * Plugs into MeshTransportNegotiator.registerAdapter().
 */
export class WebRTCAdapterFactory {
  /**
   * Returns true for transport type 'webrtc'.
   *
   * @param {string} type
   * @returns {boolean}
   */
  canCreate(type) { return type === 'webrtc' }

  /**
   * Create a WebRTCTransportAdapter wrapping an existing connection.
   *
   * @param {string} remotePodId
   * @param {object} opts
   * @param {WebRTCPeerConnection} opts.connection - Pre-negotiated connection
   * @returns {WebRTCTransportAdapter}
   */
  create(remotePodId, opts) {
    if (!opts || !opts.connection) {
      throw new Error('WebRTCAdapterFactory requires opts.connection')
    }
    return new WebRTCTransportAdapter(opts.connection)
  }
}
