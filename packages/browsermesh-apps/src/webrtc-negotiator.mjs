/**
 * webrtc-negotiator.mjs -- wires a WebRTCMeshManager + MeshSignalingChannel
 * into the adapter-factory shape `MeshTransportNegotiator.registerAdapter()`
 * expects.
 *
 * `MeshTransportNegotiator` (browsermesh-transport/src/transport.mjs) tries
 * adapters in preference order and calls the registered factory as
 * `factory(endpoint, auth) => Promise<MeshTransport>`. `PeerNode.connectToPeer()`
 * already calls `negotiator.negotiate(endpoints, auth)` where `endpoints` is
 * a map of transport type -> endpoint string -- for `'webrtc'` there is no
 * URL-shaped endpoint (WebRTC is point-to-point and negotiated out of band),
 * so by convention here `endpoints.webrtc` is simply the remote peer's podId,
 * the identifier `WebRTCMeshManager`/`WebRTCPeerConnection` already key on.
 *
 * This module owns both directions of the offer/answer/ICE dance:
 *   - Caller side: `createWebRTCTransportFactory()`'s returned factory
 *     creates an offer, sends it over the signaling channel, and resolves
 *     once the DataChannel opens.
 *   - Callee side: the same call also wires a standing `signaling.onOffer()`
 *     listener that auto-answers any inbound offer, so a peer that never
 *     calls `negotiate()` itself can still be connected *to*. Once that
 *     inbound DataChannel actually opens, the optional `onIncomingConnection`
 *     callback hands the caller a ready `WebRTCTransportAdapter` for it --
 *     `mesh-bootstrap.mjs` wires this straight into
 *     `PeerNode.adoptIncomingSession()` so the callee side ends up with the
 *     same `PeerNode`-level session bookkeeping (`sendTo()`,
 *     `onIncomingData()`) the caller side already gets from
 *     `connectToPeer()`.
 * ICE candidates are relayed in both directions for every connection,
 * regardless of which side initiated it.
 *
 * ## Multiple connections per peer (issue #116)
 * `auth.connectionId` (default `DEFAULT_CONNECTION_ID`, duplicated locally
 * in this file rather than imported from `@johnhenry/browsermesh-transport`
 * -- see that constant's own definition below for why) selects which of
 * possibly-several independent `RTCPeerConnection`s to `endpoint` this call
 * negotiates --
 * `PeerNode.connectToPeer(pubKey, endpoints, auth)` already threads `auth`
 * straight through to `negotiator.negotiate(endpoints, auth)`, so callers
 * can request a second, fully independent connection to a peer already
 * connected to (its own ICE/STUN/DTLS negotiation, own DataChannel) simply
 * by calling `connectToPeer()` again with a different `auth.connectionId`.
 * Every signaling message (`webrtc-offer`/`webrtc-answer`/`webrtc-ice`)
 * carries that same `connectionId` so concurrent exchanges with the same
 * peer never cross-route an answer or ICE candidate meant for the other
 * connection. Calls that never pass `connectionId` are unaffected -- they
 * all resolve to the peer's single `DEFAULT_CONNECTION_ID` connection, same
 * as before this was added.
 *
 * No browser-only imports at module level.
 */

// @johnhenry/browsermesh-transport (an optional peerDependency) is imported
// lazily, at each of the two `WebRTCTransportAdapter` call sites below, not
// eagerly here -- so this module doesn't force it on every consumer of
// this package's top-level `.` entrypoint. See the CHANGELOG entry
// documenting this fix.
//
// DEFAULT_CONNECTION_ID is duplicated locally (its real value, confirmed by
// reading browsermesh-transport/src/webrtc.mjs directly: `export const
// DEFAULT_CONNECTION_ID = 'default'`) rather than lazily imported --
// unlike WebRTCTransportAdapter, it's used as a *default parameter value*
// in several places below, which is evaluated at call time from whatever
// is in scope; a lazily-imported `let` binding could still be `undefined`
// the first time one of those calls happens before the import resolves. A
// plain literal has no such timing hazard.
const DEFAULT_CONNECTION_ID = 'default'

/** Default time to wait for an SDP answer before giving up. */
const DEFAULT_ANSWER_TIMEOUT_MS = 15_000

/** Default time to wait for the DataChannel to open after an answer lands. */
const DEFAULT_OPEN_TIMEOUT_MS = 15_000

/**
 * Build a `'webrtc'` adapter factory for `MeshTransportNegotiator`, backed by
 * a real `WebRTCMeshManager` and a `MeshSignalingChannel`.
 *
 * @param {object} opts
 * @param {string} opts.localPodId
 * @param {import('@johnhenry/browsermesh-transport').WebRTCMeshManager} opts.meshManager
 * @param {import('./signaling.mjs').MeshSignalingChannel} opts.signaling
 * @param {Function} [opts.onLog]
 * @param {(remotePodId: string, adapter: import('@johnhenry/browsermesh-transport').WebRTCTransportAdapter, connectionId: string) => void} [opts.onIncomingConnection]
 *   Called once the DataChannel for a *callee-side* (auto-answered) inbound
 *   offer actually opens, with a ready `WebRTCTransportAdapter` wrapping it.
 *   Optional: without it, inbound-only connections still come up at the
 *   `WebRTCMeshManager`/`WebRTCPeerConnection` level, just without the
 *   `PeerNode`-level session `mesh-bootstrap.mjs` wires this into.
 * @param {number} [opts.openTimeoutMs] - How long to wait for the callee-side
 *   DataChannel to open before giving up on firing `onIncomingConnection`
 *   (the offer/answer exchange itself already succeeded either way).
 * @returns {(endpoint: string, auth?: object) => Promise<import('@johnhenry/browsermesh-transport').WebRTCTransportAdapter>}
 *   Factory suitable for `negotiator.registerAdapter('webrtc', factory)`.
 *   `endpoint` is the remote peer's podId; `auth` may carry
 *   `{ answerTimeoutMs, openTimeoutMs, connectionId }` overrides -- see this
 *   file's header comment for `connectionId` (issue #116).
 */
export function createWebRTCTransportFactory({
  localPodId, meshManager, signaling, onLog, onIncomingConnection, openTimeoutMs: defaultOpenTimeoutMs,
}) {
  if (!localPodId) throw new Error('localPodId is required')
  if (!meshManager) throw new Error('meshManager is required')
  if (!signaling) throw new Error('signaling is required')
  const log = onLog || (() => {})

  /** @type {Set<string>} "remotePodId connectionId" pairs whose ICE relay is already wired */
  const wiredIce = new Set()
  const iceKey = (remotePodId, connectionId) => `${remotePodId} ${connectionId}`

  /**
   * Get (or create) the WebRTCPeerConnection for a peer + connectionId, and
   * make sure its locally-gathered ICE candidates get relayed exactly once,
   * no matter which side (offerer or answerer) first touches this pair.
   */
  async function getWiredConnection(remotePodId, connectionId = DEFAULT_CONNECTION_ID) {
    const conn = await meshManager.connectToPeer(remotePodId, { connectionId })
    const key = iceKey(remotePodId, connectionId)
    if (!wiredIce.has(key)) {
      wiredIce.add(key)
      conn.onIceCandidate((candidate) => {
        try {
          signaling.send('webrtc-ice', remotePodId, candidate, connectionId)
        } catch (err) {
          log('webrtc-negotiator:ice-send-failed', { remotePodId, connectionId, error: err?.message || String(err) })
        }
      })
      conn.onClose(() => wiredIce.delete(key))
    }
    return conn
  }

  /**
   * Resolve once `conn`'s DataChannel is open (immediately if it already
   * is), or reject after `timeoutMs`. Shared by the caller-side factory
   * (which already awaited this inline) and the callee-side auto-answer
   * path below (which needs the same wait before it can hand back a ready
   * adapter via `onIncomingConnection`).
   */
  async function waitForOpen(conn, timeoutMs) {
    if (conn.isOpen) return
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('WebRTC DataChannel did not open in time'))
      }, timeoutMs)
      conn.onStateChange((state) => {
        if (state === 'connected' && conn.isOpen) {
          clearTimeout(timer)
          resolve()
        }
      })
      // In case it opened between the isOpen check above and registering
      // the listener.
      if (conn.isOpen) {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  // Callee side: answer any inbound offer automatically. Registered once,
  // for the lifetime of this factory, so a peer that only ever receives
  // connections (never calls negotiate() itself) still gets connected.
  signaling.onOffer(async (fromPodId, offer, connectionId = DEFAULT_CONNECTION_ID) => {
    try {
      const conn = await getWiredConnection(fromPodId, connectionId)
      const answer = await conn.handleOffer(offer)
      signaling.send('webrtc-answer', fromPodId, answer, connectionId)
      log('webrtc-negotiator:answered', { from: fromPodId, connectionId })

      // Hand the callee side a ready transport adapter too, once its
      // DataChannel actually opens, so callers (mesh-bootstrap.mjs) can
      // give it the same PeerNode-level session bookkeeping the caller
      // side gets from connectToPeer() -- see PeerNode.adoptIncomingSession().
      if (typeof onIncomingConnection === 'function') {
        await waitForOpen(conn, defaultOpenTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS)
        const { WebRTCTransportAdapter } = await import('@johnhenry/browsermesh-transport')
        const adapter = new WebRTCTransportAdapter(conn)
        await adapter.connect()
        onIncomingConnection(fromPodId, adapter, connectionId)
      }
    } catch (err) {
      log('webrtc-negotiator:offer-failed', { from: fromPodId, connectionId, error: err?.message || String(err) })
    }
  })

  // ICE candidates arriving from either side of any connection.
  signaling.onIce((fromPodId, candidate, connectionId = DEFAULT_CONNECTION_ID) => {
    const conn = meshManager.getConnection(fromPodId, connectionId)
    if (!conn) {
      log('webrtc-negotiator:ice-no-connection', { from: fromPodId, connectionId })
      return
    }
    conn.addIceCandidate(candidate).catch((err) => {
      log('webrtc-negotiator:ice-add-failed', { from: fromPodId, connectionId, error: err?.message || String(err) })
    })
  })

  /**
   * Caller-side factory: create an offer, relay it, wait for the answer and
   * for the DataChannel to open, then hand back a MeshTransport.
   *
   * @param {string} endpoint - Remote peer's podId (by convention for 'webrtc').
   * @param {object} [auth]
   * @returns {Promise<import('@johnhenry/browsermesh-transport').WebRTCTransportAdapter>}
   */
  return async function webrtcTransportFactory(endpoint, auth) {
    const remotePodId = endpoint
    if (!remotePodId) throw new Error('webrtcTransportFactory: endpoint (remote podId) is required')

    const answerTimeoutMs = auth?.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS
    const openTimeoutMs = auth?.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
    const connectionId = auth?.connectionId ?? DEFAULT_CONNECTION_ID

    const conn = await getWiredConnection(remotePodId, connectionId)

    const answerPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`WebRTC negotiation with ${remotePodId} timed out waiting for an answer`))
      }, answerTimeoutMs)
      const unsubscribe = signaling.onAnswer((fromPodId, answer, answerConnectionId = DEFAULT_CONNECTION_ID) => {
        if (fromPodId !== remotePodId || answerConnectionId !== connectionId) return
        clearTimeout(timer)
        unsubscribe()
        resolve(answer)
      })
    })

    const offer = await conn.createOffer()
    signaling.send('webrtc-offer', remotePodId, offer, connectionId)

    const answer = await answerPromise
    await conn.handleAnswer(answer)

    try {
      await waitForOpen(conn, openTimeoutMs)
    } catch {
      throw new Error(`WebRTC DataChannel with ${remotePodId} did not open in time`)
    }

    const { WebRTCTransportAdapter } = await import('@johnhenry/browsermesh-transport')
    const adapter = new WebRTCTransportAdapter(conn)
    await adapter.connect()
    return adapter
  }
}
