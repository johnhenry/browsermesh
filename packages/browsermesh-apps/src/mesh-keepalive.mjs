/**
 * mesh-keepalive.mjs -- wires `@johnhenry/browsermesh-core`'s hardening.mjs
 * `TransportHealthCheck` to a REAL keepalive envelope protocol on
 * `PeerNode`'s own dispatch bus (issue #110, follow-up to #109's
 * `mesh-hardening.mjs`, which deliberately left `TransportHealthCheck`
 * unwired -- see that file's own header comment: "a genuine ping/pong
 * liveness probe needs a keepalive envelope type on PeerNode's own dispatch
 * bus... so the far side actually answers pings"). This file is that
 * envelope type and that far-side responder.
 *
 * Built as a `MeshService` (`mesh-service.mjs`, Phase C's attach
 * convention), NOT as a direct patch to `peer-node.mjs`, mirroring
 * `mesh-rpc.mjs`'s closest precedent: wire payloads travel over
 * `ctx.onIncomingData()`/`ctx.sendTo()`, filtered by envelope `type`, on the
 * same dispatch bus every other `MeshService` in this family uses. Unlike
 * `mesh-rpc.mjs`'s single envelope `type` with two `kind`s, this protocol
 * uses two distinct envelope types directly (`'keepalive-ping'`/
 * `'keepalive-pong'`) -- the shape issue #110 itself suggested, and a closer
 * match for `TransportHealthCheck`'s own two-sided ping/pong vocabulary.
 *
 * ---------------------------------------------------------------------------
 * WIRE PROTOCOL -- two envelope types on the shared `onIncomingData()` bus:
 *
 *   Ping: `{ type: 'keepalive-ping', timestamp }`
 *   Pong: `{ type: 'keepalive-pong', replyTo, timestamp }`
 *
 * `replyTo` echoes the ping's own `timestamp` verbatim (not used for
 * correlation here -- unlike `mesh-rpc.mjs`'s `requestId`, there is at most
 * one ping in flight per peer at a time, enforced by
 * `TransportHealthCheck`'s own `#waitingForPong` bookkeeping -- `replyTo` is
 * carried through purely so a caller inspecting captured pongs can compute
 * round-trip latency, matching the shape issue #110 itself proposed).
 *
 * ---------------------------------------------------------------------------
 * INSTANCE LIFECYCLE -- one `TransportHealthCheck` PER PEER (keyed by
 * `pubKey`), not literally per `sessionId`. This is a deliberate reading of
 * issue #110's "one TransportHealthCheck instance per active session":
 * `PeerNode` keeps at most one ACTIVE session per peer today (`ConnectionPool`
 * is explicitly deferred -- see issue #110's own scoping and
 * `mesh-hardening.mjs`'s header comment), so "per active session" and "per
 * peer" are the same thing in practice. `pubKey` is also the only
 * correlatable key actually available at both ends of this file's own
 * lifecycle hooks: `PeerNode`'s `'peer:connect'`/`'peer:disconnect'` events
 * carry `peer.fingerprint` (the pubKey), not a `sessionId`, and inbound
 * `ctx.onIncomingData()` callbacks are keyed by `fromPubKey`, not by which
 * session delivered the envelope. A future `ConnectionPool` (still
 * deliberately unwired, per issue #110) would need this file revisited to
 * key by session instead.
 *
 * Created on `'peer:connect'`, torn down (via `.stop()`) on
 * `'peer:disconnect'` -- both real `PeerNode` events (`peer-node.mjs`,
 * backed by `PeerRegistry.onPeerConnect()`/`onPeerDisconnect()`), the same
 * hook point `observability-bridge.mjs` already uses for its own
 * connect/disconnect wiring. Peers already connected at the moment this
 * service attaches (e.g. `createMeshNode({ services: [...] })` attaching
 * after some peers already connected) are picked up via a one-time
 * `peerNode.listPeers({ status: 'connected' })` scan when `attach()` runs.
 *
 * ---------------------------------------------------------------------------
 * HARDENING INTEGRATION (opt-in, degrades gracefully) -- an `'unhealthy'`
 * transition ALSO triggers `mesh-hardening.mjs`'s `TransportFailover` for
 * that peer, if `enableHardening` was also turned on for this node. The
 * caller passes `mesh-hardening.mjs`'s `createHardenedNegotiator()` return
 * value straight through as `opts.hardening` (`{ metrics, failovers, retries
 * }` -- see `mesh-bootstrap.mjs`'s own `node.hardening`); this file looks up
 * `hardening.failovers.get(endpointsKey({ webrtc: pubKey }))`, reusing
 * `mesh-hardening.mjs`'s OWN exported `endpointsKey()` and
 * `webrtc-negotiator.mjs`'s established convention that `endpoints.webrtc`
 * IS the remote peer's podId (that file's own doc comment: "by convention
 * here `endpoints.webrtc` is simply the remote peer's podId"). This is the
 * only registered transport adapter in this repo today
 * (`mesh-bootstrap.mjs` never registers anything else), so the convention
 * holds in practice -- but it is a best-effort, webrtc-shaped guess, NOT a
 * real pubKey-keyed index into `hardening.failovers` (that map is keyed by
 * `endpointsKey()`'s hash of the exact `endpoints` object a given
 * `connectToPeer()` call used, which this file never sees). If a peer was
 * connected via a different transport type, or `enableHardening` is off, or
 * no matching `TransportFailover` instance exists yet, `triggerFailover()`
 * silently no-ops (logged via `onLog`, not thrown) -- this file's own
 * liveness tracking and `ctx.emit()` events work identically either way.
 *
 * ---------------------------------------------------------------------------
 * BONUS NATIVE-TRANSPORT-CLOSE WIRING (issue #110's "bonus" item) --
 * `peer-node.mjs`'s `#createSession()` now also wires a session's
 * `transportInstance.onClose()`/`.onError()` (duck-typed against
 * `@johnhenry/browsermesh-transport`'s `MeshTransport` base class -- works
 * for `WebRTCTransportAdapter`, whose `onClose`/`onError` ultimately derive
 * from `RTCPeerConnection.connectionState`, but is not webrtc-specific) to
 * two new `PeerNode`-level events: `'peer:transport-close'`/
 * `'peer:transport-error'` (see `peer-node.mjs`'s own `on()` doc comment).
 * This file subscribes to both as a STRONGER, IMMEDIATE complement to its
 * own ping/pong escalation: rather than waiting out `maxMissed` missed pings
 * (the default `TransportHealthCheck` timeline is ~15-30s), a
 * `'peer:transport-close'` for a peer this file is tracking immediately
 * emits `'keepalive:peer-unhealthy'` and triggers failover, without waiting
 * for the next ping cycle. `TransportHealthCheck` itself has no public
 * "force unhealthy now" method (its `on()`/`off()`/`recordPong()`/
 * `start()`/`stop()` surface is the full public API -- see
 * `hardening.mjs`), so this bypasses it rather than trying to fake a missed
 * pong into it.
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`, Phase 1 of the mesh-KV-and-
 * observability plan -- see `mesh-service.mjs`'s module doc comment for the
 * full convention). Curated vocabulary:
 *
 *   - `keepalive:peer-healthy`   `{pubKey}` -- a peer's `TransportHealthCheck`
 *     (re)entered `'healthy'` (first pong, or recovery from degraded/unhealthy).
 *   - `keepalive:peer-degraded`  `{pubKey, missedCount}` -- 1..maxMissed-1
 *     consecutive missed pongs.
 *   - `keepalive:peer-unhealthy` `{pubKey, missedCount, reason}` -- `reason`
 *     is `'ping-timeout'` for the normal ping/pong escalation path, or
 *     `'transport-close'`/`'transport-error'` for the bonus wiring above.
 *   - `keepalive:failover-triggered` `{pubKey, reason}` -- this file
 *     successfully called `TransportFailover.failover()` for a peer (only
 *     possible when `enableHardening` is also on and a matching failover
 *     instance was found -- see "HARDENING INTEGRATION" above).
 *
 * No browser-only imports at module level.
 *
 * `@johnhenry/browsermesh-core` (an optional peerDependency) is lazily
 * imported inside `startCheckFor()`, guarded by a reservation/cancellation
 * scheme rather than a bare `checks.has(pubKey)` de-dup: `startCheckFor()`
 * is called both from a synchronous event handler and synchronously inside
 * `attach()`'s initial peer-scan loop, so a naive lazy import would open a
 * real race (two rapid calls for the same peer both passing the de-dup
 * check before the first call's import resolves, leaking an orphaned,
 * un-stoppable `TransportHealthCheck`). The fix: `checks.set(pubKey, {
 * pending: true, cancelled: false })` happens SYNCHRONOUSLY, before the
 * `await import()` -- so the de-dup guard (`checks.has(pubKey)`) is
 * correct the instant `startCheckFor()` returns, regardless of how long
 * the import takes. A concurrent `stopCheckFor()` arriving while pending
 * flips `cancelled` and removes the map entry immediately; when the import
 * later resolves, a cancelled reservation is a no-op (no orphaned check
 * gets installed). Every other `checks.get(pubKey)` read site (the pong
 * handler, `handleTransportClose`/`handleTransportError`,
 * `getStatus()`/`getCheck()`) is reservation-aware -- see each site's own
 * comment. See `test/mesh-keepalive.test.mjs`'s dedicated race tests.
 */

import { endpointsKey } from './mesh-hardening.mjs'

/** Envelope type for the outbound liveness probe. */
const PING_TYPE = 'keepalive-ping'
/** Envelope type for the reply to a liveness probe. */
const PONG_TYPE = 'keepalive-pong'

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`) that runs a real
 * ping/pong keepalive protocol per connected peer, backed by
 * `@johnhenry/browsermesh-core`'s `TransportHealthCheck`. See this file's
 * module doc comment for the full wire-protocol/lifecycle/hardening-
 * integration writeup.
 *
 * @param {object} [opts]
 * @param {number} [opts.intervalMs] - Passed to each per-peer
 *   `TransportHealthCheck` (default 10000, see `hardening.mjs`).
 * @param {number} [opts.timeoutMs] - Passed to each per-peer
 *   `TransportHealthCheck` (default 5000).
 * @param {number} [opts.maxMissed] - Passed to each per-peer
 *   `TransportHealthCheck` (default 3).
 * @param {Function} [opts.nowFn] - Clock override, for testing.
 * @param {{failovers: Map<string, import('@johnhenry/browsermesh-core').TransportFailover>}} [opts.hardening]
 *   `createHardenedNegotiator()`'s return value (`mesh-bootstrap.mjs`'s
 *   `node.hardening`), or `undefined`/`null` to skip failover integration
 *   entirely (this file works fine without it -- see "HARDENING
 *   INTEGRATION" above).
 * @param {Function} [opts.onLog]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createMeshKeepaliveService({
  intervalMs,
  timeoutMs,
  maxMissed,
  nowFn = Date.now,
  hardening,
  onLog,
} = {}) {
  const log = onLog || (() => {})

  return {
    name: 'keepalive',

    attach(peerNode, ctx) {
      if (typeof peerNode?.on !== 'function' || typeof peerNode?.off !== 'function') {
        throw new Error(
          'mesh-keepalive: peerNode must be a real PeerNode providing on()/off() ' +
          '("peer:connect"/"peer:disconnect" -- a duck-typed {sendTo, onIncomingData} ' +
          'node, as other MeshServices in this family accept, is not enough here).',
        )
      }

      /**
       * pubKey -> either a real health check, or a pending reservation
       * (`{pending: true, cancelled: boolean}`) while `TransportHealthCheck`
       * is being lazily imported -- see module doc comment.
       * @type {Map<string, import('@johnhenry/browsermesh-core').TransportHealthCheck | {pending: true, cancelled: boolean}>}
       */
      const checks = new Map()

      /** @param {*} entry @returns {boolean} */
      function isReservation(entry) {
        return !!entry && entry.pending === true
      }

      /**
       * Best-effort lookup of the `TransportFailover` instance
       * `mesh-hardening.mjs` scoped to this peer -- see module doc comment's
       * "HARDENING INTEGRATION" section for why this is a webrtc-convention
       * guess, not a real index.
       * @param {string} pubKey
       * @returns {import('@johnhenry/browsermesh-core').TransportFailover|null}
       */
      function getFailoverFor(pubKey) {
        if (!hardening?.failovers) return null
        return hardening.failovers.get(endpointsKey({ webrtc: pubKey })) || null
      }

      /**
       * @param {string} pubKey
       * @param {string} reason
       */
      async function triggerFailover(pubKey, reason) {
        const failover = getFailoverFor(pubKey)
        if (!failover) return
        if (failover.failingOver) return
        try {
          await failover.failover(reason)
          ctx.emit('keepalive:failover-triggered', { pubKey, reason })
        } catch (err) {
          log('mesh-keepalive:failover-failed', { pubKey, reason, error: err?.message || String(err) })
        }
      }

      /**
       * Claims the `pubKey` slot synchronously (closing the lazy-import
       * race -- see module doc comment), then lazily imports
       * `TransportHealthCheck` and installs a real check, unless the
       * reservation was cancelled (via `stopCheckFor()`) in the meantime.
       * @param {string} pubKey
       */
      function startCheckFor(pubKey) {
        if (!pubKey || checks.has(pubKey)) return

        const reservation = { pending: true, cancelled: false }
        checks.set(pubKey, reservation)

        buildCheck(pubKey, reservation).catch((err) => {
          if (checks.get(pubKey) === reservation) checks.delete(pubKey)
          log('mesh-keepalive:start-check-failed', { pubKey, error: err?.message || String(err) })
        })
      }

      /**
       * @param {string} pubKey
       * @param {{pending: true, cancelled: boolean}} reservation
       */
      async function buildCheck(pubKey, reservation) {
        const { TransportHealthCheck } = await import('@johnhenry/browsermesh-core')
        if (reservation.cancelled) return

        const check = new TransportHealthCheck({
          // TransportHealthCheck requires a truthy `transport` but only
          // threads it through to pingFn/its own emitted event payloads --
          // this file tracks liveness by pubKey, not by a real transport
          // reference, so a small duck-typed placeholder is sufficient.
          transport: { pubKey, type: 'mesh-keepalive' },
          pingFn: () => {
            ctx.sendTo(pubKey, PING_TYPE, { timestamp: nowFn() }).catch((err) => {
              log('mesh-keepalive:ping-send-failed', { pubKey, error: err?.message || String(err) })
            })
          },
          intervalMs,
          timeoutMs,
          maxMissed,
          nowFn,
        })

        check.on('healthy', () => {
          ctx.emit('keepalive:peer-healthy', { pubKey })
        })
        check.on('degraded', () => {
          ctx.emit('keepalive:peer-degraded', { pubKey, missedCount: check.missedCount })
        })
        check.on('unhealthy', () => {
          ctx.emit('keepalive:peer-unhealthy', { pubKey, missedCount: check.missedCount, reason: 'ping-timeout' })
          triggerFailover(pubKey, 'keepalive:unhealthy').catch((err) => {
            log('mesh-keepalive:trigger-failover-error', { pubKey, error: err?.message || String(err) })
          })
        })

        checks.set(pubKey, check)
        check.start()
      }

      /**
       * If `pubKey` is still a pending reservation, cancels it (the
       * in-flight lazy import will no-op when it resolves). Otherwise stops
       * and removes the real check.
       * @param {string} pubKey
       */
      function stopCheckFor(pubKey) {
        const entry = checks.get(pubKey)
        if (!entry) return
        checks.delete(pubKey)
        if (isReservation(entry)) {
          entry.cancelled = true
          return
        }
        entry.stop()
      }

      // -----------------------------------------------------------------
      // Instance lifecycle -- see module doc comment's "INSTANCE LIFECYCLE".
      // -----------------------------------------------------------------

      function handlePeerConnect(peer) {
        if (peer?.fingerprint) startCheckFor(peer.fingerprint)
      }
      function handlePeerDisconnect(peer) {
        if (peer?.fingerprint) stopCheckFor(peer.fingerprint)
      }
      // Bonus wiring (issue #110) -- see module doc comment's "BONUS
      // NATIVE-TRANSPORT-CLOSE WIRING". A stronger, immediate signal than
      // waiting out maxMissed ping/pong cycles.
      function handleTransportClose({ pubKey } = {}) {
        const entry = checks.get(pubKey)
        if (!pubKey || !entry) return
        // A pending reservation has 0 missed pings so far -- matches
        // TransportHealthCheck's own #missedCount = 0 default (hardening.mjs).
        ctx.emit('keepalive:peer-unhealthy', { pubKey, missedCount: isReservation(entry) ? 0 : entry.missedCount, reason: 'transport-close' })
        triggerFailover(pubKey, 'keepalive:transport-close').catch((err) => {
          log('mesh-keepalive:trigger-failover-error', { pubKey, error: err?.message || String(err) })
        })
      }
      function handleTransportError({ pubKey, error } = {}) {
        const entry = checks.get(pubKey)
        if (!pubKey || !entry) return
        ctx.emit('keepalive:peer-unhealthy', { pubKey, missedCount: isReservation(entry) ? 0 : entry.missedCount, reason: 'transport-error' })
        log('mesh-keepalive:transport-error', { pubKey, error })
        triggerFailover(pubKey, 'keepalive:transport-error').catch((err) => {
          log('mesh-keepalive:trigger-failover-error', { pubKey, error: err?.message || String(err) })
        })
      }

      peerNode.on('peer:connect', handlePeerConnect)
      peerNode.on('peer:disconnect', handlePeerDisconnect)
      peerNode.on('peer:transport-close', handleTransportClose)
      peerNode.on('peer:transport-error', handleTransportError)

      // Peers already connected before this service attached (e.g.
      // createMeshNode({ services }) attaching after some connectToPeer()
      // calls already happened) -- listPeers() is safe to call regardless
      // of PeerNode's own lifecycle state (see peer-node.mjs).
      if (typeof peerNode.listPeers === 'function') {
        for (const peer of peerNode.listPeers({ status: 'connected' })) {
          if (peer?.fingerprint) startCheckFor(peer.fingerprint)
        }
      }

      // -----------------------------------------------------------------
      // Inbound dispatch -- see module doc comment's "WIRE PROTOCOL".
      // -----------------------------------------------------------------

      const unsubscribeData = ctx.onIncomingData([PING_TYPE, PONG_TYPE], (fromPubKey, msg) => {
        if (msg.type === PING_TYPE) {
          // The far side answering a ping is the whole point of this file
          // -- mesh-hardening.mjs's own header comment flagged this as the
          // missing half of a genuine health check.
          ctx.sendTo(fromPubKey, PONG_TYPE, { replyTo: msg.timestamp, timestamp: nowFn() }).catch((err) => {
            log('mesh-keepalive:pong-send-failed', { to: fromPubKey, error: err?.message || String(err) })
          })
        } else if (msg.type === PONG_TYPE) {
          const entry = checks.get(fromPubKey)
          // A pong arriving while still a pending reservation would be a
          // stray/duplicate from a prior connection -- this file can't have
          // sent a ping for this peer yet (check.start() hasn't run), so
          // it's safe to drop.
          if (entry && !isReservation(entry)) entry.recordPong()
        }
      })

      const api = {
        /**
         * @param {string} pubKey
         * @returns {'healthy'|'degraded'|'unhealthy'|null} `null` if this
         *   peer is not currently tracked (never connected or already
         *   disconnected). A pending reservation (lazy import still in
         *   flight) reports `'healthy'` -- matching `TransportHealthCheck`'s
         *   own `#status = 'healthy'` default at construction, before
         *   `start()` runs (`hardening.mjs`) -- not `null`, so callers see
         *   the exact same synchronous-default behavior as before this file
         *   lazy-loaded the class.
         */
        getStatus(pubKey) {
          const entry = checks.get(pubKey)
          if (!entry) return null
          return isReservation(entry) ? 'healthy' : entry.status
        },
        /**
         * @param {string} pubKey
         * @returns {import('@johnhenry/browsermesh-core').TransportHealthCheck|null}
         *   `null` also while a pending reservation hasn't finished
         *   installing yet -- never returns the internal reservation shape.
         */
        getCheck(pubKey) {
          const entry = checks.get(pubKey)
          if (!entry || isReservation(entry)) return null
          return entry
        },
        /** @returns {string[]} pubKeys currently tracked. */
        listTracked() {
          return [...checks.keys()]
        },
      }

      return {
        api,
        teardown() {
          peerNode.off('peer:connect', handlePeerConnect)
          peerNode.off('peer:disconnect', handlePeerDisconnect)
          peerNode.off('peer:transport-close', handleTransportClose)
          peerNode.off('peer:transport-error', handleTransportError)
          unsubscribeData()
          for (const pubKey of [...checks.keys()]) stopCheckFor(pubKey)
        },
      }
    },
  }
}

export { PING_TYPE, PONG_TYPE }
