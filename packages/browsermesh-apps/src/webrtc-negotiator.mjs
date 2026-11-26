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

/**
 * What an offer says about glare: present (a number of 1 or more) when the sender follows the rule "the lower pod id's
 * offer wins". An offer without it comes from a release that does not, and is assumed to yield (see the offer handler).
 */
export const GLARE_VERSION = 1

/**
 * When this side's offer wins a glare (the other side's offer is dropped) and no answer has come this long after, the
 * offer is sent again: it may never have reached a peer that was not there yet when it was first sent. Longer than a
 * signalling round trip, so in a true glare the answer is in before this runs out and nothing is sent twice.
 */
export const GLARE_RESEND_MS = 1500

/** Default time to wait for an SDP answer before giving up. */
const DEFAULT_ANSWER_TIMEOUT_MS = 15_000

/** Default time to wait for the DataChannel to open after an answer lands. */
const DEFAULT_OPEN_TIMEOUT_MS = 15_000

/**
 * How many inbound connections may be connecting (answered, DataChannel not yet open) at once. Generous on
 * purpose: a node that is dialled by dozens of peers at once (a relay, a gateway) answers them all; the bound
 * only has to stop a peer that sends offers it never completes from growing the node's connection table
 * without limit.
 */
export const DEFAULT_MAX_HALF_OPEN_INBOUND = 64

/**
 * How long an inbound connection may stay half-open. Four times the 15 s a dialling side waits for its own
 * DataChannel, so a slow but working path (relay-only ICE, a busy tab) is not cut short.
 */
export const DEFAULT_HALF_OPEN_TIMEOUT_MS = 60_000

/**
 * Build a `'webrtc'` adapter factory for `MeshTransportNegotiator`, backed by
 * a real `WebRTCMeshManager` and a `MeshSignalingChannel`.
 *
 * @param {object} opts
 * @param {string} opts.localPodId
 * @param {import('@johnhenry/browsermesh-transport').WebRTCMeshManager} opts.meshManager
 * @param {import('./signaling.mjs').MeshSignalingChannel} opts.signaling
 * @param {Function} [opts.onLog]
 * @param {(remotePodId: string, adapter: import('@johnhenry/browsermesh-transport').WebRTCTransportAdapter, connectionId: string, info: { restarted: boolean }) => void} [opts.onIncomingConnection]
 *   `info.restarted` is true when the offer arrived for a connection this side held open: the peer started over on it.
 *   Called once the DataChannel for a *callee-side* (auto-answered) inbound
 *   offer actually opens, with a ready `WebRTCTransportAdapter` wrapping it.
 *   Optional: without it, inbound-only connections still come up at the
 *   `WebRTCMeshManager`/`WebRTCPeerConnection` level, just without the
 *   `PeerNode`-level session `mesh-bootstrap.mjs` wires this into.
 * @param {(failure: { remotePodId: string, connectionId: string, reason: string }) => void} [opts.onBindingFailure]
 *   Called once when a connection is closed because the peer did not prove the identity it claimed
 *   (`reason`: `timeout` for a peer that sent no proof, `bad-signature`, `no-fingerprint`, ...), on either
 *   side. `mesh-bootstrap.mjs` turns it into the node event `peer:binding-failed`. A caller's `connect()`
 *   also rejects with the reason in its message.
 * @param {number} [opts.openTimeoutMs] - How long to wait for the callee-side
 *   DataChannel to open before giving up on firing `onIncomingConnection`
 *   (the offer/answer exchange itself already succeeded either way).
 * @param {number} [opts.maxHalfOpenInbound=64] - How many inbound connections may be connecting (answered, not yet
 *   open) at once. When one more offer arrives the oldest unfinished connection is closed to make room, so a real
 *   peer is never locked out by stale ones. An offer for a connection that is already open (a renegotiation) or
 *   already counted does not take a slot. `Infinity` turns the cap off.
 * @param {number} [opts.halfOpenTimeoutMs=60000] - How long an inbound connection may stay half-open before it is
 *   closed and its slot freed. `Infinity` turns the deadline off.
 *   The live numbers are on the returned factory as `halfOpenInbound` (`max`, `timeoutMs`, `count`).
 * @returns {(endpoint: string, auth?: object) => Promise<import('@johnhenry/browsermesh-transport').WebRTCTransportAdapter>}
 *   Factory suitable for `negotiator.registerAdapter('webrtc', factory)`.
 *   `endpoint` is the remote peer's podId; `auth` may carry
 *   `{ answerTimeoutMs, openTimeoutMs, connectionId }` overrides -- see this
 *   file's header comment for `connectionId` (issue #116).
 */
export function createWebRTCTransportFactory({
  localPodId, meshManager, signaling, onLog, onIncomingConnection, openTimeoutMs: defaultOpenTimeoutMs,
  onBindingFailure,
  maxHalfOpenInbound = DEFAULT_MAX_HALF_OPEN_INBOUND,
  halfOpenTimeoutMs = DEFAULT_HALF_OPEN_TIMEOUT_MS,
}) {
  if (!localPodId) throw new Error('localPodId is required')
  if (!meshManager) throw new Error('meshManager is required')
  if (!signaling) throw new Error('signaling is required')
  if (maxHalfOpenInbound !== Infinity && !(Number.isInteger(maxHalfOpenInbound) && maxHalfOpenInbound > 0)) {
    throw new TypeError('maxHalfOpenInbound must be a positive integer (or Infinity)')
  }
  if (!(halfOpenTimeoutMs > 0)) throw new TypeError('halfOpenTimeoutMs must be a positive number (or Infinity)')
  const log = onLog || (() => {})

  /**
   * Inbound connections that were answered and have not opened yet, oldest first (Map keeps insertion order).
   * @type {Map<string, { conn: object|null, timer: any, evicted: boolean }>}
   */
  const halfOpen = new Map()

  function closeQuietly(conn) {
    try { conn?.close?.() } catch (err) { log('webrtc-negotiator:half-open-close-failed', { error: err?.message || String(err) }) }
  }

  /** Take a slot for an inbound offer, making room by closing the oldest unfinished connection if needed. */
  function admitHalfOpen(key, remotePodId, connectionId) {
    while (halfOpen.size >= maxHalfOpenInbound) {
      const [oldKey, old] = halfOpen.entries().next().value
      halfOpen.delete(oldKey)
      clearTimeout(old.timer)
      old.evicted = true
      closeQuietly(old.conn)
      log('webrtc-negotiator:half-open-evicted', { key: oldKey, for: remotePodId })
    }
    const entry = { conn: null, timer: null, evicted: false }
    halfOpen.set(key, entry)
    return entry
  }

  function releaseHalfOpen(key, entry) {
    clearTimeout(entry.timer)
    if (halfOpen.get(key) === entry) halfOpen.delete(key)
  }

  /** Watch an answered inbound connection: it frees its slot when it opens or closes, and is closed at the deadline. */
  function watchHalfOpen(key, entry, conn, remotePodId, connectionId) {
    entry.conn = conn
    conn.onStateChange((state) => {
      if (state === 'closed' || (state === 'connected' && conn.isOpen)) releaseHalfOpen(key, entry)
    })
    if (conn.isOpen) { releaseHalfOpen(key, entry); return }
    if (halfOpenTimeoutMs === Infinity) return
    entry.timer = setTimeout(() => {
      if (halfOpen.get(key) !== entry || conn.isOpen) return
      releaseHalfOpen(key, entry)
      log('webrtc-negotiator:half-open-timed-out', { from: remotePodId, connectionId })
      closeQuietly(conn)
    }, halfOpenTimeoutMs)
    entry.timer?.unref?.()
  }

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
      // A connection the transport closed because the peer did not prove its identity is announced, with why.
      conn.onStateChange((state) => {
        if (state === 'closed' && conn.bindingFailure) {
          const failure = { remotePodId, connectionId, reason: conn.bindingFailure }
          log('webrtc-negotiator:binding-failed', failure)
          try { onBindingFailure?.(failure) } catch (err) { log('webrtc-negotiator:binding-failure-callback-threw', { error: err?.message || String(err) }) }
        }
      })
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
        } else if (state === 'closed') {
          // Closed before it opened: say why now rather than after the timeout. The transport closes a
          // connection whose peer did not prove its identity, and records the reason.
          clearTimeout(timer)
          const err = new Error(conn.bindingFailure
            ? `WebRTC connection with ${conn.remotePodId ?? 'the peer'} closed: identity binding failed: ${conn.bindingFailure}`
            : `WebRTC connection with ${conn.remotePodId ?? 'the peer'} closed before it opened`)
          err.closedEarly = true
          err.bindingFailure = conn.bindingFailure ?? null
          reject(err)
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

  /**
   * One transport adapter per connection. A connection is handed out by the caller side (the dial returns it) and by
   * the callee side (`onIncomingConnection`), and a peer that starts over on a connection this side still holds
   * hands it out again: each time it is the same adapter, so the node wires the connection in once and every inbound
   * message is delivered once, however often the connection is handed out. A closed adapter is never reused.
   * @type {WeakMap<object, object>}
   */
  const adapters = new WeakMap()
  async function adapterFor(conn) {
    const have = adapters.get(conn)
    if (have && have.state !== 'closed') return have
    const { WebRTCTransportAdapter } = await import('@johnhenry/browsermesh-transport')
    const raced = adapters.get(conn) // another path made one while the import was settling
    if (raced && raced.state !== 'closed') return raced
    const adapter = new WebRTCTransportAdapter(conn)
    adapters.set(conn, adapter)
    await adapter.connect()
    return adapter
  }

  /**
   * Dials this side has an offer out for, whose answer has not been applied: `key` -> `{ yield() }`. Two peers that
   * dial each other at the same moment (glare) each hold one of these when the other's offer arrives.
   * @type {Map<string, { yield: () => void, resend: () => void }>}
   */
  const dialing = new Map()

  // Callee side: answer any inbound offer automatically. Registered once,
  // for the lifetime of this factory, so a peer that only ever receives
  // connections (never calls negotiate() itself) still gets connected.
  signaling.onOffer(async (fromPodId, offer, connectionId = DEFAULT_CONNECTION_ID) => {
    const key = iceKey(fromPodId, connectionId)
    let entry = null
    // An offer for a connection this side holds OPEN is a peer that started over (a page loaded again, a node made anew): the
    // connection is swapped underneath and whatever link ran over the old one is over. The node is told when it is handed out.
    let restarted = false
    // Glare: this side's own offer to the same peer is out. One of the two offers must give way, and both sides must
    // agree which: the lower pod id's offer wins. A peer that does not say it follows the rule (an older release,
    // whose offer has no `glare` marker) is assumed to yield, as every older release does, so then ours wins.
    const mine = dialing.get(key)
    if (mine) {
      const theirsFollowsRule = Number(offer?.glare) >= 1
      if (!theirsFollowsRule || localPodId < fromPodId) {
        log('webrtc-negotiator:glare-won', { from: fromPodId, connectionId })
        // The peer answers our offer; its own offer is dropped. Our offer may never have reached it (it was not there
        // when we sent it): if no answer has come by then, it is sent again, and the peer gives way to it (or an older
        // peer answers it).
        mine.resendIfUnanswered()
        return
      }
      log('webrtc-negotiator:glare-yielded', { from: fromPodId, connectionId })
      mine.yield() // our dial stops waiting for an answer and takes the connection the peer's offer opens
    }
    try {
      // An offer for a connection that is already open (a renegotiation) or already counted takes no slot.
      const existing = meshManager.getConnection?.(fromPodId, connectionId)
      restarted = existing?.isOpen === true
      if (!halfOpen.has(key) && !existing?.isOpen) entry = admitHalfOpen(key, fromPodId, connectionId)
      const conn = await getWiredConnection(fromPodId, connectionId)
      if (entry?.evicted) { closeQuietly(conn); return }
      if (entry) watchHalfOpen(key, entry, conn, fromPodId, connectionId)
      const answer = await conn.handleOffer(offer)
      signaling.send('webrtc-answer', fromPodId, answer, connectionId)
      log('webrtc-negotiator:answered', { from: fromPodId, connectionId })

      // Hand the callee side a ready transport adapter too, once its
      // DataChannel actually opens, so callers (mesh-bootstrap.mjs) can
      // give it the same PeerNode-level session bookkeeping the caller
      // side gets from connectToPeer() -- see PeerNode.adoptIncomingSession().
      if (typeof onIncomingConnection === 'function') {
        await waitForOpen(conn, defaultOpenTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS)
        onIncomingConnection(fromPodId, await adapterFor(conn), connectionId, { restarted })
      }
    } catch (err) {
      if (entry) {
        // Still held: the offer failed before the connection opened, so do not leave it in the table. Already
        // released (opened, evicted, timed out): nothing more to close.
        const held = halfOpen.get(key) === entry
        releaseHalfOpen(key, entry)
        if (held) closeQuietly(entry.conn)
      }
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
  async function webrtcTransportFactory(endpoint, auth) {
    const remotePodId = endpoint
    if (!remotePodId) throw new Error('webrtcTransportFactory: endpoint (remote podId) is required')

    const answerTimeoutMs = auth?.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS
    const openTimeoutMs = auth?.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
    const connectionId = auth?.connectionId ?? DEFAULT_CONNECTION_ID

    const conn = await getWiredConnection(remotePodId, connectionId)

    let stopWaiting = () => {}
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
      stopWaiting = () => { clearTimeout(timer); unsubscribe() }
    })
    answerPromise.catch(() => {}) // read below; a failure before that must not be an unhandled rejection

    // From here until the answer is applied this dial is "out": an offer from the same peer that arrives meanwhile is
    // glare (see the standing offer handler), and may make this dial give way.
    const key = iceKey(remotePodId, connectionId)
    let gaveWay = false
    let giveWay = () => {}
    const gaveWayPromise = new Promise((resolve) => { giveWay = () => { gaveWay = true; resolve() } })
    let sentOffer = null
    let answered = false
    let resendTimer = null
    const sendOffer = () => signaling.send('webrtc-offer', remotePodId, { ...sentOffer, glare: GLARE_VERSION }, connectionId)
    const dial = {
      yield: giveWay,
      resendIfUnanswered() {
        if (resendTimer) return
        resendTimer = setTimeout(() => {
          resendTimer = null
          if (!sentOffer || answered || gaveWay || dialing.get(key) !== dial) return
          try { sendOffer() } catch { /* the signalling transport is down: the answer timeout says so */ }
        }, GLARE_RESEND_MS)
        resendTimer.unref?.()
      },
    }
    dialing.set(key, dial)
    try {
      let offer
      try {
        offer = await conn.createOffer()
      } catch (err) {
        if (gaveWay) offer = null // the peer's offer replaced the connection this one was being made on
        else throw err
      }
      if (offer && !gaveWay) { sentOffer = offer; sendOffer() }
      // The answer to our offer, or the peer's offer taking over: then the connection opens through the answering path.
      const outcome = gaveWay ? 'gave-way' : await Promise.race([answerPromise.then((answer) => ({ answer })), gaveWayPromise.then(() => 'gave-way')])
      if (outcome === 'gave-way') stopWaiting()
      else { answered = true; await conn.handleAnswer(outcome.answer) }
    } catch (err) {
      // The offer never left (the signalling transport is down, or the connection could not make one): stop waiting for an answer to it.
      stopWaiting()
      throw err
    } finally {
      clearTimeout(resendTimer)
      if (dialing.get(key) === dial) dialing.delete(key)
    }

    try {
      await waitForOpen(conn, openTimeoutMs)
    } catch (err) {
      if (err?.closedEarly) throw err // the connection was closed, with the reason (see waitForOpen)
      throw new Error(`WebRTC DataChannel with ${remotePodId} did not open in time`)
    }

    return adapterFor(conn)
  }

  Object.defineProperty(webrtcTransportFactory, 'halfOpenInbound', {
    enumerable: true,
    value: Object.freeze({
      max: maxHalfOpenInbound,
      timeoutMs: halfOpenTimeoutMs,
      get count() { return halfOpen.size },
    }),
  })
  return webrtcTransportFactory
}
