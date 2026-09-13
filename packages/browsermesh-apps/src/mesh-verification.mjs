/**
 * mesh-verification.mjs -- Phase 4 of the browsermesh-app-layer-migration
 * plan (issue #119): wraps `peer-verification.mjs`'s `VerificationQuorum`/
 * `Attestation` as a `MeshService` (`mesh-service.mjs`, Phase C's
 * `attach()`/`ctx` convention).
 *
 * `VerificationQuorum` dispatches the SAME job to N peers, hashes each
 * peer's reported result, groups by hash, and applies a voting strategy
 * (unanimous/majority/threshold/byzantine) to decide a winning result with a
 * confidence score and a set of `Attestation`s from the peers that agreed.
 * "Enables trustless compute verification without TEEs" (see that file's own
 * header) -- genuinely trust-bearing subject matter, approved to wire
 * (issue #119: "real trust-bearing subject matter... proceed with normal
 * care"), unlike `peer-compute.mjs`/`peer-terminal.mjs`, which stay blocked
 * on issue #86's still-unresolved execution-gating design pass.
 *
 * ---------------------------------------------------------------------------
 * WHAT `VerificationQuorum` ITSELF DOES AND DOES NOT DO -- read directly off
 * its constructor and `submitVerified()`:
 *
 *   - `scheduler.dispatch(peerId, job) -> Promise<result>` is a required
 *     constructor dependency. `VerificationQuorum` never sends a byte over
 *     any network itself -- exactly like `peer-compute.mjs`'s
 *     `FederatedCompute`, it is "a pure orchestrator that delegates real
 *     execution to an injected scheduler.dispatch() entirely outside the
 *     file" (this plan's own "Context" section, describing the #86
 *     correction for that sibling module). `#dispatchWithTimeout()` merely
 *     races whatever Promise `scheduler.dispatch()` returns against
 *     `policy.timeoutMs`.
 *   - `trust.getReputation(podId)` / `trust.listTrustedPeers(threshold?)` is
 *     the other required dependency, consulted only inside
 *     `#selectVerifiers()` to rank and pick which peers to ask.
 *
 * THE ONE GENUINELY NEW PIECE OF LOGIC THIS FILE CONTRIBUTES, THEREFORE, IS
 * THE WIRE PROTOCOL BEHIND A REAL `scheduler` -- turning "ask peer X to run
 * this job and tell me the result" into actual `ctx.sendTo()` /
 * `ctx.onIncomingData()` traffic. This is the same shape of gap
 * `mesh-timestamp.mjs` closes for `TimestampAuthority.stamp()`'s
 * `peerTimestamps` collection, and `peer-routing.mjs`'s `ServerSharing`
 * proxy-request/response closes for HTTP proxying: the wrapped class
 * documents an injectable seam; this file is the first real implementation
 * of that seam wired to a real `PeerNode`.
 *
 * ---------------------------------------------------------------------------
 * LOCAL/ADMIN vs. PEER-INITIATED -- the actual real flow, traced end to end
 * (not just the two named methods `setPolicy`/`submitVerified`):
 *
 *   - `api.setPolicy(policy)` / `api.submitVerified(job, opts)` are LOCAL
 *     calls: this node's own operator/application code deciding to ask for
 *     (or configure how it asks for) verification. Nothing about calling
 *     these requires anything from a remote peer first.
 *   - `submitVerified()` -> `#selectVerifiers()` -> `trust.listTrustedPeers()`
 *     is ALSO local: it consults this node's OWN trust view (this file's
 *     default `trust` adapter reads `ctx.registry`, this node's own
 *     `PeerRegistry` -- never a remote query).
 *   - `submitVerified()` -> `scheduler.dispatch(peerId, job)` is where a
 *     PEER gets involved: this file's default `scheduler` sends a real
 *     `'verify-request'` envelope to `peerId` and awaits a `'verify-response'`
 *     reply.
 *   - Receiving a `'verify-request'` FROM a peer -- i.e., being asked to
 *     serve as a verifier -- is the genuinely PEER-INITIATED action, and the
 *     one that needs an authorization check: before this node ever executes
 *     anyone else's job, it gates the request through
 *     `ctx.registry.checkAccess(fromPubKey, accessResource, accessAction)`
 *     (default resource/action: `'verification'`/`'execute'`), exactly the
 *     `registry.checkAccess()` gate `chunk-replication.mjs`/`mesh-kv.mjs`/
 *     `mesh-relay-host.mjs` already established for "a peer wants this node
 *     to do something on its behalf." A denied or ungranted peer gets an
 *     explicit `{error: 'access denied'}` response (not a silent drop) --
 *     see "WHY AN EXPLICIT DENIAL RESPONSE" below.
 *
 * ---------------------------------------------------------------------------
 * `executeFn` -- REQUIRED FOR THIS NODE TO SERVE AS A VERIFIER, NOT PROVIDED
 * BY THIS FILE. Even after `checkAccess()` authorizes the requesting peer,
 * "what does it mean to actually run `job`" is left ENTIRELY to a
 * caller-supplied `opts.executeFn(job) -> Promise<result>`. This file never
 * invents a way to execute arbitrary job payloads -- the same restraint
 * `peer-compute.mjs`'s `FederatedCompute` already shows by delegating to an
 * injected `scheduler.dispatch()`, just one layer further out: THIS file's
 * OWN default `scheduler.dispatch()` implementation (the wire protocol) is
 * real and wired, but the thing it ultimately calls on the answering side
 * (`executeFn`) is not. A node whose operator never supplies `executeFn`
 * can still SUBMIT verification jobs (the requesting role) but cleanly
 * refuses to ANSWER them (the executing role) -- an authorized peer gets a
 * fast, explicit `{error: 'verifier not configured to execute jobs'}`
 * rather than a silent hang until the requester's own timeout. This mirrors
 * issue #119's "approved to wire... proceed with normal care": the
 * quorum/voting/attestation protocol itself is wired for real, while what
 * code actually runs for a remote peer remains an explicit, per-deployment
 * opt-in -- consistent with `peer-compute.mjs`/`peer-terminal.mjs` staying
 * blocked on issue #86's still-open "what gates remote execution" design
 * pass, rather than this file quietly deciding that question on the side.
 *
 * WHY AN EXPLICIT DENIAL RESPONSE (not a silent drop, unlike e.g.
 * `chunk-replication.mjs`'s checkAccess-gated inbound mutation handlers):
 * those are fire-and-forget broadcasts with no waiting caller. Here, the
 * REQUESTING side's `scheduler.dispatch()` Promise is already open and
 * waiting -- silently dropping would just make an unauthorized/unconfigured
 * peer indistinguishable from a slow or dead one, forcing every such case to
 * eat the full `dispatchTimeoutMs`. `VerificationQuorum.submitVerified()`
 * already treats ANY rejected dispatch (timeout OR explicit error) the same
 * way -- exclude that peer's result, emit `'timeout'` regardless of the
 * real reason (see that method's own `catch`-adjacent `else` branch) -- so
 * an explicit fast rejection changes nothing about quorum correctness, only
 * how long a caller waits to find out.
 *
 * ---------------------------------------------------------------------------
 * DEFAULT `trust` ADAPTER -- `PeerRegistry` (`peer-registry.mjs`) already
 * implements `getReputation(pubKey)` natively with the exact signature
 * `VerificationQuorum` wants. `listTrustedPeers(minLevel?)` does not exist
 * on `PeerRegistry` as a single call, so this file's default composes it
 * from two calls that DO exist: `peerNode.listPeers({status:'connected'})`
 * (the reachable candidate set -- asking a peer with no live connection to
 * verify a job cannot work) filtered through `ctx.registry.isTrusted(pubKey,
 * null, minLevel)` (that peer's own established default `minLevel` of
 * `0.25`, matching `PeerRegistry.isTrusted()`'s own documented default).
 * Supply `opts.trust` directly to bypass this (e.g. to consider peers beyond
 * those currently connected, or a different trust source entirely).
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`, see `mesh-service.mjs`'s module doc
 * comment for the full convention). `VerificationQuorum`'s own pre-existing
 * `on`/`off` surface (`'verified'`/`'divergent'`/`'timeout'`) is bridged
 * through verbatim, prefixed `verification:`:
 *
 *   - `verification:verified`  -- `{result, confidence, attestations}`,
 *     `VerificationQuorum`'s own `'verified'` payload, unchanged.
 *   - `verification:divergent` -- `{jobId, groups}`, `VerificationQuorum`'s
 *     own `'divergent'` payload, unchanged.
 *   - `verification:timeout`   -- `{peerId, jobId, error}`, `VerificationQuorum`'s
 *     own `'timeout'` payload (fired for ANY failed/rejected dispatch, not
 *     only a real elapsed-time timeout -- see that class's own code).
 *
 * Plus this file's own, for the wire layer (mirroring `mesh-timestamp.mjs`'s
 * `timestamp:witness-timeout` / `peer-routing.mjs`'s
 * `mesh-routing:server-share-served`):
 *
 *   - `verification:verify-served` `{from, requestId, ok}` -- this node, AS
 *     A VERIFIER, answered an authorized `'verify-request'` (`ok: true` if
 *     `executeFn` succeeded, `false` if it threw).
 *   - `verification:verify-request-denied` `{from, requestId, reason}` --
 *     an inbound `'verify-request'` was rejected before `executeFn` ever
 *     ran (`reason`: `'access_denied'` or `'no_executor'`).
 *
 * No browser-only imports at module level.
 */

import { VerificationQuorum } from './peer-verification.mjs'

/** Shared envelope `type` for both verify request/response directions (tagged by `kind`), mirroring `mesh-timestamp.mjs`'s `'time-request'`/`'time-response'` shape. */
const DEFAULT_VERIFICATION_ENVELOPE_TYPE = 'mesh-verification'

/** How long the default `scheduler.dispatch()` waits for a matching `'verify-response'` before giving up. Independent of (and typically ⩾) `VerificationQuorum`'s own internal `policy.timeoutMs` -- whichever fires first wins; this one exists purely so a never-answering peer's pending entry is always eventually cleaned up. */
const DEFAULT_DISPATCH_TIMEOUT_MS = 30000

/** Default `resource`/`action` pair checked via `ctx.registry.checkAccess(fromPubKey, resource, action)` before honoring an inbound `'verify-request'`. */
const DEFAULT_ACCESS_RESOURCE = 'verification'
const DEFAULT_ACCESS_ACTION = 'execute'

/** Default trust threshold for the default `trust.listTrustedPeers()` adapter, matching `PeerRegistry.isTrusted()`'s own documented default. */
const DEFAULT_TRUST_THRESHOLD = 0.25

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) wrapping
 * `VerificationQuorum`. See this file's module doc comment for the full
 * design writeup (what's local/admin-only vs. peer-initiated, why
 * `executeFn` is required-but-not-provided, the default `trust` adapter).
 *
 * @param {object} [opts]
 * @param {{dispatch: (peerId: string, job: object) => Promise<*>}} [opts.scheduler]
 *   Defaults to a real mesh-wired scheduler (`ctx.sendTo()` a `'verify-request'`,
 *   await a matching `'verify-response'`). Supply your own to bypass the
 *   network entirely (e.g. local-only testing) or use a different transport.
 * @param {{getReputation: (podId: string) => number, listTrustedPeers: (threshold?: number) => string[]}} [opts.trust]
 *   Defaults to an adapter over `ctx.registry`/`peerNode.listPeers()` -- see
 *   module doc comment's "DEFAULT `trust` ADAPTER" section.
 * @param {(job: object) => Promise<*>} [opts.executeFn] - Called to actually
 *   run an inbound, authorized verification job and produce this node's
 *   result. REQUIRED for this node to usefully serve as a verifier -- see
 *   module doc comment. Omitting it still allows this node to SUBMIT
 *   verification jobs (the requesting role).
 * @param {number} [opts.dispatchTimeoutMs=30000] - How long the default
 *   `scheduler.dispatch()` waits for a `'verify-response'`.
 * @param {string} [opts.envelopeType='mesh-verification']
 * @param {string} [opts.accessResource='verification'] - `resource` passed to
 *   `ctx.registry.checkAccess()` for inbound `'verify-request'`s.
 * @param {string} [opts.accessAction='execute'] - `action` passed to
 *   `ctx.registry.checkAccess()` for inbound `'verify-request'`s.
 * @param {Function} [opts.onLog]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createVerificationService({
  scheduler,
  trust,
  executeFn,
  dispatchTimeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS,
  envelopeType = DEFAULT_VERIFICATION_ENVELOPE_TYPE,
  accessResource = DEFAULT_ACCESS_RESOURCE,
  accessAction = DEFAULT_ACCESS_ACTION,
  onLog,
} = {}) {
  const log = onLog || (() => {})

  return {
    name: 'verification',

    attach(peerNode, ctx) {
      // -- Default trust adapter (see module doc comment) -------------------
      const effectiveTrust = trust || {
        getReputation: (podId) => ctx.registry.getReputation(podId),
        listTrustedPeers: (threshold = DEFAULT_TRUST_THRESHOLD) => {
          const connected = typeof peerNode.listPeers === 'function'
            ? peerNode.listPeers({ status: 'connected' })
            : []
          return connected
            .map((p) => p.fingerprint)
            .filter(Boolean)
            .filter((pubKey) => ctx.registry.isTrusted(pubKey, null, threshold))
        },
      }

      // -- Default scheduler: real request/response wire protocol -----------
      let reqSeq = 0
      const nextRequestId = () => `${peerNode.podId}:${Date.now()}:${++reqSeq}`

      /** @type {Map<string, {resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>}>} */
      const pendingDispatches = new Map()

      const effectiveScheduler = scheduler || {
        dispatch(peerId, job) {
          const requestId = nextRequestId()
          const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              pendingDispatches.delete(requestId)
              reject(new Error(`mesh-verification: dispatch to ${peerId} timed out after ${dispatchTimeoutMs}ms`))
            }, dispatchTimeoutMs)
            pendingDispatches.set(requestId, { resolve, reject, timer })
          })

          ctx.sendTo(peerId, envelopeType, { kind: 'verify-request', requestId, job }).catch((err) => {
            const pending = pendingDispatches.get(requestId)
            if (pending) {
              clearTimeout(pending.timer)
              pendingDispatches.delete(requestId)
              pending.reject(err)
            }
          })

          return promise
        },
      }

      const quorum = new VerificationQuorum({
        scheduler: effectiveScheduler,
        trust: effectiveTrust,
        onLog: (level, msg) => log('mesh-verification:internal', { level, msg }),
      })

      // Bridge VerificationQuorum's own pre-existing on()/off() events
      // through ctx.emit() -- see module doc comment's "Observability
      // events" section.
      const onVerified = (outcome) => ctx.emit('verification:verified', outcome)
      const onDivergent = (data) => ctx.emit('verification:divergent', data)
      const onTimeout = (data) => ctx.emit('verification:timeout', data)
      quorum.on('verified', onVerified)
      quorum.on('divergent', onDivergent)
      quorum.on('timeout', onTimeout)

      // -- Inbound wire handling ----------------------------------------------
      async function handleVerifyRequest(fromPubKey, msg) {
        const { requestId, job } = msg

        const access = ctx.registry.checkAccess(fromPubKey, accessResource, accessAction)
        if (!access.allowed) {
          ctx.emit('verification:verify-request-denied', { from: fromPubKey, requestId, reason: 'access_denied' })
          await ctx.sendTo(fromPubKey, envelopeType, { kind: 'verify-response', requestId, error: 'access denied' }).catch((err) => {
            log('mesh-verification:response-send-failed', { to: fromPubKey, requestId, error: err?.message || String(err) })
          })
          return
        }

        if (typeof executeFn !== 'function') {
          ctx.emit('verification:verify-request-denied', { from: fromPubKey, requestId, reason: 'no_executor' })
          await ctx.sendTo(fromPubKey, envelopeType, { kind: 'verify-response', requestId, error: 'verifier not configured to execute jobs' }).catch((err) => {
            log('mesh-verification:response-send-failed', { to: fromPubKey, requestId, error: err?.message || String(err) })
          })
          return
        }

        let response
        try {
          const result = await executeFn(job)
          response = { kind: 'verify-response', requestId, result }
        } catch (err) {
          response = { kind: 'verify-response', requestId, error: err?.message || String(err) }
        }

        try {
          await ctx.sendTo(fromPubKey, envelopeType, response)
          ctx.emit('verification:verify-served', { from: fromPubKey, requestId, ok: !response.error })
        } catch (err) {
          log('mesh-verification:response-send-failed', { to: fromPubKey, requestId, error: err?.message || String(err) })
        }
      }

      function handleVerifyResponse(msg) {
        const pending = pendingDispatches.get(msg.requestId)
        if (!pending) return // already resolved (timed out or answered) -- ignore
        pendingDispatches.delete(msg.requestId)
        clearTimeout(pending.timer)
        if (msg.error) {
          pending.reject(new Error(msg.error))
        } else {
          pending.resolve(msg.result)
        }
      }

      const unsubscribe = ctx.onIncomingData(envelopeType, (fromPubKey, msg) => {
        if (!msg || typeof msg.kind !== 'string') return
        if (msg.kind === 'verify-request') {
          handleVerifyRequest(fromPubKey, msg).catch((err) => {
            log('mesh-verification:request-handling-failed', { from: fromPubKey, requestId: msg.requestId, error: err?.message || String(err) })
          })
        } else if (msg.kind === 'verify-response') {
          handleVerifyResponse(msg)
        }
      })

      const api = {
        /**
         * @param {object} job
         * @param {object} [opts]
         * @param {string[]} [opts.verifiers]
         * @param {string} [opts.verifyLevel]
         * @returns {Promise<{result: *, confidence: number, attestations: import('./peer-verification.mjs').Attestation[]}>}
         */
        submitVerified: (job, submitOpts) => quorum.submitVerified(job, submitOpts),

        /** @param {object} policy */
        setPolicy: (policy) => quorum.setPolicy(policy),
      }

      return {
        api,
        teardown() {
          quorum.off('verified', onVerified)
          quorum.off('divergent', onDivergent)
          quorum.off('timeout', onTimeout)
          unsubscribe()
          for (const pending of pendingDispatches.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error('mesh-verification: service torn down while a dispatch was still in flight'))
          }
          pendingDispatches.clear()
        },
      }
    },
  }
}

export {
  DEFAULT_VERIFICATION_ENVELOPE_TYPE,
  DEFAULT_DISPATCH_TIMEOUT_MS,
  DEFAULT_ACCESS_RESOURCE,
  DEFAULT_ACCESS_ACTION,
  DEFAULT_TRUST_THRESHOLD,
}
