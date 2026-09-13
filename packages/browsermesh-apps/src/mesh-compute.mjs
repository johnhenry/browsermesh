/**
 * mesh-compute.mjs -- Phase 11 of the browsermesh-app-layer-migration plan
 * (issue #118): wraps `peer-compute.mjs`'s `FederatedCompute` as a
 * `MeshService` (`mesh-service.mjs`, Phase C's `attach()`/`ctx` convention).
 *
 * `FederatedCompute` splits a job into chunks (via a caller-supplied
 * `splitFn`), dispatches each chunk to a peer via an injected
 * `scheduler.dispatch(peerId, job) -> Promise<result>`, retries on failure,
 * and merges completed results (via a caller-supplied `mergeFn`). "Federated
 * compute orchestration... enables 'nomadic supercomputer' and 'compute
 * marketplace' scenarios" (see that file's own header) -- this is exactly
 * the "dispatch code to a remote peer and have it run" scenario issue #86's
 * design pass was about. This file is the mesh wiring that pass unblocked;
 * see issue #86's resolution comment and `mesh-verification.mjs`'s own
 * header comment (Phase 4, the closest possible precedent -- this file
 * mirrors its structure and reasoning almost verbatim, one layer over for
 * compute instead of verification).
 *
 * ---------------------------------------------------------------------------
 * WHAT `FederatedCompute` ITSELF DOES AND DOES NOT DO -- read directly off
 * its constructor and `#dispatchChunk()`:
 *
 *   - `scheduler.dispatch(peerId, job) -> Promise<result>` and
 *     `scheduler.listAvailablePeers() -> string[]` are REQUIRED constructor
 *     dependencies (`FederatedCompute` throws immediately if either is
 *     missing). `FederatedCompute` never sends a byte over any network
 *     itself -- it is "a pure orchestrator that delegates real execution to
 *     an injected scheduler.dispatch() entirely outside the file" (this
 *     plan's own "Context" section). `#dispatchChunk()` calls
 *     `this.#scheduler.dispatch(chunk.assignee, { chunkId, jobId, index,
 *     payload })` and interprets whatever it resolves to as `{ output?,
 *     cost? }` (falling back to the raw value as `output` if it isn't
 *     shaped that way).
 *
 * THE ONE GENUINELY NEW PIECE OF LOGIC THIS FILE CONTRIBUTES, THEREFORE, IS
 * THE WIRE PROTOCOL BEHIND A REAL `scheduler` -- turning "ask peer X to run
 * this chunk and tell me the result" into actual `ctx.sendTo()` /
 * `ctx.onIncomingData()` traffic, exactly the same shape of gap
 * `mesh-verification.mjs` closes for `VerificationQuorum.submitVerified()`'s
 * `scheduler.dispatch()`. `scheduler.dispatch()` is the NETWORK-COMMUNICATION
 * seam (this file builds a real implementation of it); it is explicitly NOT
 * the "run untrusted code" seam -- that boundary is one layer further in,
 * at `executeFn` below.
 *
 * ---------------------------------------------------------------------------
 * LOCAL/ADMIN vs. PEER-INITIATED -- the actual real flow, traced end to end:
 *
 *   - `api.submit(jobSpec)` / `api.cancel(jobId)` / `api.getJob(id)` /
 *     `api.listJobs(filter)` / `api.getStats()` are LOCAL calls: this node's
 *     own operator/application code deciding to submit (or inspect) a
 *     federated compute job. Nothing about calling these requires anything
 *     from a remote peer first.
 *   - `submit()` -> `scheduler.listAvailablePeers()` (when `jobSpec.peers`
 *     isn't supplied) is ALSO local: it consults this node's OWN connected-
 *     peer view (this file's default `listAvailablePeers` reads
 *     `peerNode.listPeers({status:'connected'})` -- never a remote query).
 *   - `submit()` -> `scheduler.dispatch(peerId, job)` is where a PEER gets
 *     involved: this file's default `scheduler` sends a real
 *     `'compute-request'` envelope to `peerId` and awaits a matching
 *     `'compute-response'` reply.
 *   - Receiving a `'compute-request'` FROM a peer -- i.e., being asked to
 *     RUN SOMEONE ELSE'S CODE -- is the genuinely PEER-INITIATED action, and
 *     the one that needs an authorization check: before this node ever
 *     executes anyone else's chunk, it gates the request through
 *     `ctx.registry.checkAccess(fromPubKey, accessResource, accessAction)`
 *     (default resource/action: `'compute'`/`'execute'`), exactly the
 *     `registry.checkAccess()` gate `mesh-verification.mjs`/
 *     `chunk-replication.mjs`/`mesh-kv.mjs`/`mesh-relay-host.mjs` already
 *     established for "a peer wants this node to do something on its
 *     behalf." A denied or ungranted peer gets an explicit
 *     `{error: 'access denied'}` response (not a silent drop) -- see
 *     "WHY AN EXPLICIT DENIAL RESPONSE" below.
 *
 * ---------------------------------------------------------------------------
 * `executeFn` -- REQUIRED FOR THIS NODE TO SERVE AS A COMPUTE WORKER, NOT
 * PROVIDED BY THIS FILE. Even after `checkAccess()` authorizes the
 * requesting peer, "what does it mean to actually run a chunk's payload" is
 * left ENTIRELY to a caller-supplied `opts.executeFn(job) -> Promise<result>`
 * (`job` here is the SAME `{ chunkId, jobId, index, payload }` shape
 * `FederatedCompute` itself hands to `scheduler.dispatch()` -- this file adds
 * no extra wrapping or unwrapping between the wire and `executeFn`). This
 * file never invents a way to execute arbitrary chunk payloads -- no
 * sandboxing, no interpretation, no `eval`, no worker pool -- that is
 * entirely the node operator's problem to solve, exactly the restraint
 * `mesh-verification.mjs`'s `executeFn` already shows for verification jobs,
 * itself modeled on this same module's own pre-migration design ("a pure
 * orchestrator that delegates real execution... entirely outside the
 * file"). Per issue #86's resolved design pass: "Neither `TerminalHost`'s
 * `shell` nor `FederatedCompute`'s `scheduler` has any real implementation
 * anywhere in this repo today... the node operator [is] required to supply
 * their own real executor. No default shell... or scheduler is built as
 * part of this." A node whose operator never supplies `executeFn` can still
 * SUBMIT compute jobs (the requesting role) but cleanly refuses to RUN them
 * (the executing role) -- an authorized peer gets a fast, explicit
 * `{error: 'compute worker not configured to execute jobs'}` rather than a
 * silent hang until the requester's own retry/timeout budget is exhausted.
 *
 * WHY AN EXPLICIT DENIAL RESPONSE (not a silent drop, unlike e.g.
 * `chunk-replication.mjs`'s checkAccess-gated inbound mutation handlers):
 * those are fire-and-forget broadcasts with no waiting caller. Here, the
 * REQUESTING side's `scheduler.dispatch()` Promise is already open and
 * waiting -- silently dropping would just make an unauthorized/unconfigured
 * peer indistinguishable from a slow or dead one, forcing every such case to
 * eat the full `dispatchTimeoutMs` PLUS `FederatedCompute`'s own
 * `#dispatchChunk()` retry loop (`COMPUTE_DEFAULTS.maxRetries`, reassigning
 * the chunk to the next peer each time) before finally failing. An explicit
 * fast rejection changes nothing about eventual correctness (a rejected
 * dispatch is still just a rejected dispatch as far as `#dispatchChunk()`'s
 * retry logic is concerned), only how long a caller waits to find out.
 *
 * ---------------------------------------------------------------------------
 * DEFAULT `listAvailablePeers` -- `peerNode.listPeers({status:'connected'})`
 * (the reachable candidate set -- asking a peer with no live connection to
 * run a chunk cannot work), mapped to each peer's `.fingerprint`, mirroring
 * `mesh-verification.mjs`'s own default `trust.listTrustedPeers()` adapter.
 * Unlike verification, there is no trust filter here by default -- supply
 * `opts.listAvailablePeers` (or pass `scheduler` outright) to add one (e.g.
 * only dispatch compute jobs to peers above some trust threshold), since
 * `FederatedCompute` itself has no notion of trust at all (that's
 * `mesh-verification.mjs`'s job, one layer up, for callers who want BOTH
 * distributed execution AND cross-checked correctness -- see
 * `peer-verification.mjs`'s own header for how the two compose).
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`, see `mesh-service.mjs`'s module doc
 * comment for the full convention). `FederatedCompute`'s own pre-existing
 * `on`/`off` surface is bridged through verbatim, prefixed `compute:`:
 *
 *   - `compute:submitted`       -- `FederatedJob` (job accepted, about to split).
 *   - `compute:split`           -- `{jobId, count}`.
 *   - `compute:chunk-assigned`  -- `{jobId, chunkId, peerId}`.
 *   - `compute:chunk-complete`  -- `{jobId, chunkId, result}`.
 *   - `compute:chunk-failed`    -- `{jobId, chunkId, error}`.
 *   - `compute:merged`          -- `{jobId, result}`.
 *   - `compute:completed`       -- `FederatedJob` (final, status 'completed').
 *   - `compute:failed`          -- `FederatedJob` (final, status 'failed'/'cancelled').
 *
 * Plus this file's own, for the wire layer (mirroring
 * `mesh-verification.mjs`'s `verification:verify-served` /
 * `verification:verify-request-denied`):
 *
 *   - `compute:chunk-served`  `{from, requestId, ok}` -- this node, AS A
 *     WORKER, answered an authorized `'compute-request'` (`ok: true` if
 *     `executeFn` succeeded, `false` if it threw).
 *   - `compute:chunk-request-denied` `{from, requestId, reason}` -- an
 *     inbound `'compute-request'` was rejected before `executeFn` ever ran
 *     (`reason`: `'access_denied'` or `'no_executor'`).
 *
 * No browser-only imports at module level.
 */

import { FederatedCompute } from './peer-compute.mjs'

/** Shared envelope `type` for both compute request/response directions (tagged by `kind`), mirroring `mesh-verification.mjs`'s `'mesh-verification'` shape. */
const DEFAULT_COMPUTE_ENVELOPE_TYPE = 'mesh-compute'

/** How long the default `scheduler.dispatch()` waits for a matching `'compute-response'` before giving up. Independent of `FederatedCompute`'s own `#dispatchChunk()` retry loop (`COMPUTE_DEFAULTS.maxRetries`) -- a per-attempt timeout, not a whole-job one; a never-answering peer's pending entry is always eventually cleaned up and the chunk retried on the next peer. */
const DEFAULT_COMPUTE_DISPATCH_TIMEOUT_MS = 30000

/** Default `resource`/`action` pair checked via `ctx.registry.checkAccess(fromPubKey, resource, action)` before honoring an inbound `'compute-request'`. */
const DEFAULT_COMPUTE_ACCESS_RESOURCE = 'compute'
const DEFAULT_COMPUTE_ACCESS_ACTION = 'execute'

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) wrapping
 * `FederatedCompute`. See this file's module doc comment for the full
 * design writeup (what's local/admin-only vs. peer-initiated, why
 * `executeFn` is required-but-not-provided, the default `listAvailablePeers`
 * adapter).
 *
 * @param {object} [opts]
 * @param {{dispatch: (peerId: string, job: object) => Promise<*>, listAvailablePeers: () => string[]}} [opts.scheduler]
 *   Defaults to a real mesh-wired scheduler (`ctx.sendTo()` a
 *   `'compute-request'`, await a matching `'compute-response'`; peer
 *   discovery via `opts.listAvailablePeers` or `peerNode.listPeers()`).
 *   Supply your own to bypass the network entirely (e.g. local-only
 *   testing) or use a different transport/discovery source.
 * @param {() => string[]} [opts.listAvailablePeers] - Used by the DEFAULT
 *   scheduler only (ignored if `opts.scheduler` is supplied directly).
 *   Defaults to connected peers' fingerprints via `peerNode.listPeers()`.
 * @param {Function} [opts.splitFn] - Constructor-level default `(payload) =>
 *   chunkPayloads[]`, used by `api.submit(jobSpec)` when `jobSpec.splitFn`
 *   is omitted. Neither this nor a per-call `jobSpec.splitFn` is required at
 *   construction time -- `FederatedCompute.submit()` itself throws (via the
 *   missing-function call) if neither is ultimately supplied for a given
 *   job, exactly like today's direct `FederatedCompute` usage.
 * @param {Function} [opts.mergeFn] - Constructor-level default
 *   `(results[]) => mergedResult`, same override behavior as `splitFn`.
 * @param {(job: {chunkId: string, jobId: string, index: number, payload: *}) => Promise<*>} [opts.executeFn]
 *   Called to actually run an inbound, authorized compute chunk and produce
 *   this node's result. REQUIRED for this node to usefully serve as a
 *   compute worker -- see module doc comment. Omitting it still allows this
 *   node to SUBMIT compute jobs (the requesting role).
 * @param {number} [opts.dispatchTimeoutMs=30000] - How long the default
 *   `scheduler.dispatch()` waits for a `'compute-response'`.
 * @param {string} [opts.envelopeType='mesh-compute']
 * @param {string} [opts.accessResource='compute'] - `resource` passed to
 *   `ctx.registry.checkAccess()` for inbound `'compute-request'`s.
 * @param {string} [opts.accessAction='execute'] - `action` passed to
 *   `ctx.registry.checkAccess()` for inbound `'compute-request'`s.
 * @param {Function} [opts.onLog]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createComputeService({
  scheduler,
  listAvailablePeers,
  splitFn: defaultSplitFn,
  mergeFn: defaultMergeFn,
  executeFn,
  dispatchTimeoutMs = DEFAULT_COMPUTE_DISPATCH_TIMEOUT_MS,
  envelopeType = DEFAULT_COMPUTE_ENVELOPE_TYPE,
  accessResource = DEFAULT_COMPUTE_ACCESS_RESOURCE,
  accessAction = DEFAULT_COMPUTE_ACCESS_ACTION,
  onLog,
} = {}) {
  const log = onLog || (() => {})

  return {
    name: 'compute',

    attach(peerNode, ctx) {
      // -- Default scheduler: real request/response wire protocol -----------
      let reqSeq = 0
      const nextRequestId = () => `${peerNode.podId}:${Date.now()}:${++reqSeq}`

      /** @type {Map<string, {resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>}>} */
      const pendingDispatches = new Map()

      const effectiveListAvailablePeers = listAvailablePeers || (() => {
        const connected = typeof peerNode.listPeers === 'function'
          ? peerNode.listPeers({ status: 'connected' })
          : []
        return connected.map((p) => p.fingerprint).filter(Boolean)
      })

      const effectiveScheduler = scheduler || {
        dispatch(peerId, job) {
          const requestId = nextRequestId()
          const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              pendingDispatches.delete(requestId)
              reject(new Error(`mesh-compute: dispatch to ${peerId} timed out after ${dispatchTimeoutMs}ms`))
            }, dispatchTimeoutMs)
            pendingDispatches.set(requestId, { resolve, reject, timer })
          })

          ctx.sendTo(peerId, envelopeType, { kind: 'compute-request', requestId, job }).catch((err) => {
            const pending = pendingDispatches.get(requestId)
            if (pending) {
              clearTimeout(pending.timer)
              pendingDispatches.delete(requestId)
              pending.reject(err)
            }
          })

          return promise
        },
        listAvailablePeers: effectiveListAvailablePeers,
      }

      const compute = new FederatedCompute({
        scheduler: effectiveScheduler,
        onLog: (level, msg) => log('mesh-compute:internal', { level, msg }),
      })

      // Bridge FederatedCompute's own pre-existing on()/off() events through
      // ctx.emit() -- see module doc comment's "Observability events" section.
      const bridgedEvents = [
        'submitted', 'split', 'chunk-assigned', 'chunk-complete',
        'chunk-failed', 'merged', 'completed', 'failed',
      ]
      const bridgeHandlers = bridgedEvents.map((event) => {
        const handler = (data) => ctx.emit(`compute:${event}`, data)
        compute.on(event, handler)
        return [event, handler]
      })

      // -- Inbound wire handling ----------------------------------------------
      async function handleComputeRequest(fromPubKey, msg) {
        const { requestId, job } = msg

        const access = ctx.registry.checkAccess(fromPubKey, accessResource, accessAction)
        if (!access.allowed) {
          ctx.emit('compute:chunk-request-denied', { from: fromPubKey, requestId, reason: 'access_denied' })
          await ctx.sendTo(fromPubKey, envelopeType, { kind: 'compute-response', requestId, error: 'access denied' }).catch((err) => {
            log('mesh-compute:response-send-failed', { to: fromPubKey, requestId, error: err?.message || String(err) })
          })
          return
        }

        if (typeof executeFn !== 'function') {
          ctx.emit('compute:chunk-request-denied', { from: fromPubKey, requestId, reason: 'no_executor' })
          await ctx.sendTo(fromPubKey, envelopeType, { kind: 'compute-response', requestId, error: 'compute worker not configured to execute jobs' }).catch((err) => {
            log('mesh-compute:response-send-failed', { to: fromPubKey, requestId, error: err?.message || String(err) })
          })
          return
        }

        let response
        try {
          const result = await executeFn(job)
          response = { kind: 'compute-response', requestId, result }
        } catch (err) {
          response = { kind: 'compute-response', requestId, error: err?.message || String(err) }
        }

        try {
          await ctx.sendTo(fromPubKey, envelopeType, response)
          ctx.emit('compute:chunk-served', { from: fromPubKey, requestId, ok: !response.error })
        } catch (err) {
          log('mesh-compute:response-send-failed', { to: fromPubKey, requestId, error: err?.message || String(err) })
        }
      }

      function handleComputeResponse(msg) {
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
        if (msg.kind === 'compute-request') {
          handleComputeRequest(fromPubKey, msg).catch((err) => {
            log('mesh-compute:request-handling-failed', { from: fromPubKey, requestId: msg.requestId, error: err?.message || String(err) })
          })
        } else if (msg.kind === 'compute-response') {
          handleComputeResponse(msg)
        }
      })

      const api = {
        /**
         * @param {object} jobSpec - See `FederatedCompute.submit()`'s own
         *   JSDoc. `splitFn`/`mergeFn` fall back to this service's own
         *   constructor-level defaults when omitted from `jobSpec`.
         * @returns {Promise<import('./peer-compute.mjs').FederatedJob>}
         */
        submit: (jobSpec) => compute.submit({
          splitFn: defaultSplitFn,
          mergeFn: defaultMergeFn,
          ...jobSpec,
        }),

        /** @param {string} jobId */
        cancel: (jobId) => compute.cancel(jobId),

        /** @param {string} id */
        getJob: (id) => compute.getJob(id),

        /** @param {object} [filter] */
        listJobs: (filter) => compute.listJobs(filter),

        getStats: () => compute.getStats(),
      }

      return {
        api,
        teardown() {
          for (const [event, handler] of bridgeHandlers) compute.off(event, handler)
          unsubscribe()
          for (const pending of pendingDispatches.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error('mesh-compute: service torn down while a dispatch was still in flight'))
          }
          pendingDispatches.clear()
        },
      }
    },
  }
}

export {
  DEFAULT_COMPUTE_ENVELOPE_TYPE,
  DEFAULT_COMPUTE_DISPATCH_TIMEOUT_MS,
  DEFAULT_COMPUTE_ACCESS_RESOURCE,
  DEFAULT_COMPUTE_ACCESS_ACTION,
}
