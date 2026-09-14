/**
 * mesh-orchestrator.mjs -- Phase 3 of the agent-runtime plan (issue #92):
 * wraps `orchestrator.mjs`'s `MeshOrchestrator` as a `MeshService`
 * (`mesh-service.mjs`, Phase C's `attach()`/`ctx` convention), mirroring
 * `mesh-compute.mjs`/`mesh-verification.mjs`/`mesh-agent-swarm.mjs`/
 * `mesh-swarm.mjs`'s own established structure for "wrap a real, dormant
 * class with a real request/response wire protocol and a `checkAccess()`
 * gate for the peer-initiated actions."
 *
 * ---------------------------------------------------------------------------
 * WHAT `MeshOrchestrator` ITSELF DOES AND DOES NOT DO (read directly off
 * `orchestrator.mjs`):
 *
 *   `MeshOrchestrator` requires `peerNode` and optionally accepts
 *   `serviceAdvertiser`/`serviceBrowser` (both confirmed still unwired
 *   anywhere in this repo -- `ServiceAdvertiser`/`ServiceBrowser` from
 *   `peer-services.mjs` are never constructed by real code -- left `null`
 *   here per this phase's plan; reviving `peer-services.mjs` stays a
 *   separate, smaller follow-up), `router`, `runtimeRegistry`,
 *   `remoteSessionBroker`, `resourceRegistry`, `auditRecorder`,
 *   `peerRegistry` -- all default `null`. `listPods()`/`getPodStatus()`/
 *   `topPods()` are pure LOCAL aggregation over this node's own
 *   `peerNode`/known-peers/`runtimeRegistry` state -- no network round-trip,
 *   no peer-initiated authorization concern, so this file exposes them on
 *   `api` as thin, ungated passthroughs.
 *
 *   `execOnPod()`/`deploySkill()`/`drainPod()` are different: each already
 *   has its OWN internal local-vs-remote branch (local when `podId ===
 *   peerNode.podId`; otherwise via `#remoteSessionBroker`/`runtimeRegistry`
 *   if wired, or a registered `#knownPeers` entry's own `exec`/`send`/
 *   `drain`/`deploySkill` callback). Without `remoteSessionBroker` wired
 *   (not part of this phase's scope -- see module doc comment above) and
 *   with no peer pre-registered via `orchestrator.addPeer()`, calling any of
 *   these three against a REAL remote pod that this node has no other
 *   channel to would simply throw/fail locally with no network traffic ever
 *   sent. That is exactly the gap this file closes: a real request/response
 *   wire protocol, modeled directly on `mesh-compute.mjs`'s single-target
 *   dispatch shape (an orchestrator action always targets exactly one named
 *   pod, never a broadcast or a pool-selection the way `mesh-compute.mjs`'s
 *   own `ResourceScorer`-driven `runComputeTask()` does), so `api.execOnPod`/
 *   `api.deploySkill`/`api.drainPod` here dispatch a real `ctx.sendTo()`
 *   request to the target pod's peer and await a matching response when the
 *   target isn't this node itself, and call straight through to the local
 *   `MeshOrchestrator` method (no network hop) when it is.
 *
 * ---------------------------------------------------------------------------
 * ROUTER WIRING -- `MeshOrchestrator` calls exactly one method on its
 * injected `router`: `routeService()` calls `this.#router.addRoute(targetPodId,
 * targetPodId, 1)` (guarded by `this.#router && this.#router.addRoute`).
 * `peer-routing.mjs`'s `createMeshRoutingService()` returns an `api` with
 * `addRoute(targetPodId, nextHop, hops, ttl)` -- same arity, same meaning
 * (target, next hop, hop count, optional TTL override) -- so `node.router?.api`
 * (the `attachService()` handle's `.api` field) IS shape-compatible and is
 * wired straight through as `router` below when a caller supplies it (e.g.
 * `mesh-bootstrap.mjs`'s `enableOrchestrator` passing `node.router?.api`
 * when `enableRouting` was also set). No other method is ever called on
 * `router`, so nothing else about `MeshRouter`'s real API needed checking.
 *
 * ---------------------------------------------------------------------------
 * SWARM/LEADER-ELECTION -- `mesh-swarm.mjs` (`SwarmCoordinator`/
 * `LeaderElection`/`TaskDistributor`) has no reference to `MeshOrchestrator`
 * anywhere, and `MeshOrchestrator` has no reference to swarm/leader-election
 * concepts anywhere either (confirmed by reading both files in full) --
 * this remains true after this phase. Pod orchestration (which pod runs
 * what) and swarm task distribution (which peer runs which sub-task of a
 * decomposed goal) are separate concerns this repo has never connected; no
 * connection is forced here.
 *
 * ---------------------------------------------------------------------------
 * AUTHORIZATION -- `execOnPod`/`deploySkill`/`drainPod` are the genuinely
 * PEER-INITIATED, RISKY actions (arbitrary remote command execution,
 * arbitrary content deployed to this node's filesystem-adjacent skill
 * store, and forcibly disconnecting/migrating this node's own workload,
 * respectively) -- exactly `orchestrator.mjs`'s own header comment's
 * "eight `meshctl`-CLI-shaped agent tools", the three whose `BrowserTool`
 * subclasses (`MeshctlExecTool`/`MeshctlDeployTool`/`MeshctlDrainTool`)
 * already declare `get permission() { return 'network' }` (vs. `'read'` for
 * the pods/status/top query tools). Before honoring an inbound
 * `'orchestrator-request'` for any of the three, this node gates it via
 * `ctx.registry.checkAccess(fromPubKey, accessResource, action)` (action is
 * one of `'exec'`/`'deploy'`/`'drain'`), exactly the `registry.checkAccess()`
 * gate `mesh-compute.mjs`/`mesh-verification.mjs`/`mesh-agent-swarm.mjs`/
 * `mesh-swarm.mjs` already established for "a peer wants this node to do
 * something on its behalf." A denied request gets an explicit
 * `{error: 'access denied'}` response (not a silent drop) -- the REQUESTING
 * side's dispatch Promise is already open and waiting, so a silent drop
 * would just make an unauthorized peer indistinguishable from a slow or
 * dead one (same reasoning as `mesh-compute.mjs`'s own "WHY AN EXPLICIT
 * DENIAL RESPONSE" section).
 *
 * `listPods`/`getPodStatus`/`topPods` are NOT gated and have no wire
 * protocol at all here -- they are local-only queries over this node's own
 * knowledge, with no peer-initiated request path this file introduces (a
 * caller wanting a REMOTE pod's live status would need its own mechanism;
 * nothing in `orchestrator.mjs` today asks a remote peer to answer a status
 * query on this node's behalf).
 *
 * ---------------------------------------------------------------------------
 * `api.orchestrator` -- the raw, unwrapped `MeshOrchestrator` instance is
 * also exposed directly on `api` (not just the gated wire-protocol
 * wrappers), so a later phase (registering the 8 `Meshctl*Tool` classes
 * into a `BrowserToolRegistry`) can construct them directly against it --
 * `Meshctl*Tool`'s real constructor is `constructor(orchestrator) { ... }`,
 * expecting a raw `MeshOrchestrator`, not a wrapped service. Anything
 * reached via `api.orchestrator` directly (as opposed to `api.execOnPod`/
 * `api.deploySkill`/`api.drainPod`) runs `MeshOrchestrator`'s own
 * un-gated, local-only logic -- exactly like `api.orchestrator.listPods()`
 * already is unconditionally. A future phase wiring `Meshctl*Tool`s into an
 * LLM-drivable registry should prefer this service's own gated
 * `api.execOnPod`/`api.deploySkill`/`api.drainPod` (or reconstruct
 * equivalent gating) for any tool surface an untrusted remote actor could
 * ultimately trigger; `api.orchestrator` itself does not re-add the gate
 * `MeshOrchestrator`'s own methods never had.
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`, see `mesh-service.mjs`'s module doc
 * comment for the full convention):
 *
 *   - `orchestrator:request-denied` `{from, requestId, action, reason}` --
 *     an inbound `'orchestrator-request'` was rejected before the
 *     underlying `MeshOrchestrator` method ever ran (`reason`:
 *     `'access_denied'` or `'unsupported_action'`).
 *   - `orchestrator:request-served` `{from, requestId, action, ok}` -- this
 *     node, as the TARGET pod, answered an authorized request (`ok: true`
 *     if the underlying `MeshOrchestrator` method resolved, `false` if it
 *     threw).
 *
 * No browser-only imports at module level.
 */

import { MeshOrchestrator } from './orchestrator.mjs'

/** Shared envelope `type` for both orchestrator request/response directions (tagged by `kind`), mirroring `mesh-compute.mjs`'s `'mesh-compute'` shape. */
const DEFAULT_ORCHESTRATOR_ENVELOPE_TYPE = 'mesh-orchestrator'

/** How long `api.execOnPod`/`api.deploySkill`/`api.drainPod` wait for a matching `'orchestrator-response'` before giving up, for a REMOTE target. Mirrors `mesh-compute.mjs`'s own default dispatch timeout. */
const DEFAULT_ORCHESTRATOR_DISPATCH_TIMEOUT_MS = 30000

/** Default `resource` passed to `ctx.registry.checkAccess(fromPubKey, resource, action)` for all three gated actions (`action` is `'exec'`/`'deploy'`/`'drain'`). */
const DEFAULT_ACCESS_RESOURCE = 'orchestrator'

/** The only actions an inbound `'orchestrator-request'` may name -- see module doc comment's "AUTHORIZATION" section for why these three (and only these three) are gated/wire-dispatched at all. */
const RISKY_ACTIONS = Object.freeze(['exec', 'deploy', 'drain'])

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) wrapping
 * `MeshOrchestrator`. See this file's module doc comment for the full
 * design writeup (what's local-only vs. peer-initiated/gated, the router
 * shape-compatibility finding, the swarm non-relationship finding).
 *
 * @param {object} [opts]
 * @param {object} [opts.router] - Passed straight through to
 *   `MeshOrchestrator`'s own `router` constructor option. Compatible shape:
 *   `peer-routing.mjs`'s `createMeshRoutingService()` `api` (has
 *   `addRoute(targetPodId, nextHop, hops, ttl)`, the only method
 *   `MeshOrchestrator` ever calls on it) -- see module doc comment's
 *   "ROUTER WIRING" section.
 * @param {object} [opts.runtimeRegistry] - Passed straight through.
 * @param {object} [opts.remoteSessionBroker] - Passed straight through.
 * @param {object} [opts.resourceRegistry] - Passed straight through.
 * @param {object} [opts.auditRecorder] - Passed straight through.
 * @param {number} [opts.dispatchTimeoutMs=30000] - How long
 *   `api.execOnPod`/`api.deploySkill`/`api.drainPod` wait for a
 *   `'orchestrator-response'` when the target isn't this node itself.
 * @param {string} [opts.envelopeType='mesh-orchestrator']
 * @param {string} [opts.accessResource='orchestrator'] - `resource` passed to
 *   `ctx.registry.checkAccess()` for inbound `'orchestrator-request'`s.
 * @param {Function} [opts.onLog]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createOrchestratorService({
  router,
  runtimeRegistry,
  remoteSessionBroker,
  resourceRegistry,
  auditRecorder,
  dispatchTimeoutMs = DEFAULT_ORCHESTRATOR_DISPATCH_TIMEOUT_MS,
  envelopeType = DEFAULT_ORCHESTRATOR_ENVELOPE_TYPE,
  accessResource = DEFAULT_ACCESS_RESOURCE,
  onLog,
} = {}) {
  const log = onLog || (() => {})

  return {
    name: 'orchestrator',

    attach(peerNode, ctx) {
      const orchestrator = new MeshOrchestrator({
        peerNode,
        router: router ?? null,
        runtimeRegistry: runtimeRegistry ?? null,
        remoteSessionBroker: remoteSessionBroker ?? null,
        resourceRegistry: resourceRegistry ?? null,
        auditRecorder: auditRecorder ?? null,
        peerRegistry: ctx.registry,
        onLog: (msg) => log('mesh-orchestrator:internal', { message: msg }),
      })

      // -- Outbound dispatch: real request/response wire protocol -----------
      let reqSeq = 0
      const nextRequestId = () => `${peerNode.podId}:${Date.now()}:${++reqSeq}`

      /** @type {Map<string, {resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>}>} */
      const pendingDispatches = new Map()

      function dispatch(podId, action, args) {
        const requestId = nextRequestId()
        const promise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingDispatches.delete(requestId)
            reject(new Error(`mesh-orchestrator: ${action} on ${podId} timed out after ${dispatchTimeoutMs}ms`))
          }, dispatchTimeoutMs)
          pendingDispatches.set(requestId, { resolve, reject, timer })
        })

        ctx.sendTo(podId, envelopeType, { kind: 'orchestrator-request', requestId, action, args }).catch((err) => {
          const pending = pendingDispatches.get(requestId)
          if (pending) {
            clearTimeout(pending.timer)
            pendingDispatches.delete(requestId)
            pending.reject(err)
          }
        })

        return promise
      }

      // -- Inbound wire handling ----------------------------------------------
      async function respond(fromPubKey, requestId, payload) {
        try {
          await ctx.sendTo(fromPubKey, envelopeType, { kind: 'orchestrator-response', requestId, ...payload })
        } catch (err) {
          log('mesh-orchestrator:response-send-failed', { to: fromPubKey, requestId, error: err?.message || String(err) })
        }
      }

      async function runAction(action, args) {
        if (action === 'exec') return orchestrator.execOnPod(args.podId, args.command)
        if (action === 'deploy') return orchestrator.deploySkill(args.podId, args.skillContent)
        if (action === 'drain') return orchestrator.drainPod(args.podId)
        throw new Error(`unsupported action: ${action}`)
      }

      async function handleOrchestratorRequest(fromPubKey, msg) {
        const { requestId, action, args = {} } = msg

        if (!RISKY_ACTIONS.includes(action)) {
          ctx.emit('orchestrator:request-denied', { from: fromPubKey, requestId, action, reason: 'unsupported_action' })
          await respond(fromPubKey, requestId, { error: `unsupported action: ${action}` })
          return
        }

        const access = ctx.registry.checkAccess(fromPubKey, accessResource, action)
        if (!access.allowed) {
          ctx.emit('orchestrator:request-denied', { from: fromPubKey, requestId, action, reason: 'access_denied' })
          await respond(fromPubKey, requestId, { error: 'access denied' })
          return
        }

        let response
        try {
          const result = await runAction(action, args)
          response = { result }
        } catch (err) {
          response = { error: err?.message || String(err) }
        }

        await respond(fromPubKey, requestId, response)
        ctx.emit('orchestrator:request-served', { from: fromPubKey, requestId, action, ok: !response.error })
      }

      function handleOrchestratorResponse(msg) {
        const pending = pendingDispatches.get(msg.requestId)
        if (!pending) return // no longer waiting (already timed out, or not ours) -- ignore
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
        if (msg.kind === 'orchestrator-request') {
          handleOrchestratorRequest(fromPubKey, msg).catch((err) => {
            log('mesh-orchestrator:request-handling-failed', { from: fromPubKey, requestId: msg.requestId, error: err?.message || String(err) })
          })
        } else if (msg.kind === 'orchestrator-response') {
          handleOrchestratorResponse(msg)
        }
      })

      // -- api ----------------------------------------------------------------
      const localPodId = () => orchestrator.localPodId

      const api = {
        /** Raw `MeshOrchestrator` instance -- see module doc comment's `api.orchestrator` section. */
        orchestrator,

        // Local-only aggregation queries -- no wire protocol, no gate. See
        // module doc comment's "AUTHORIZATION" section for why.
        listPods: (filter) => orchestrator.listPods(filter),
        getPodStatus: (podId) => orchestrator.getPodStatus(podId),
        topPods: () => orchestrator.topPods(),

        // Risky, peer-initiated-capable actions: local call when the target
        // is this node itself (no network round-trip, mirroring
        // mesh-agent-swarm.mjs's own local-self-assignment shortcut), a real
        // gated wire dispatch otherwise.
        execOnPod: (podId, command) => (podId === localPodId()
          ? orchestrator.execOnPod(podId, command)
          : dispatch(podId, 'exec', { podId, command })),
        deploySkill: (podId, skillContent) => (podId === localPodId()
          ? orchestrator.deploySkill(podId, skillContent)
          : dispatch(podId, 'deploy', { podId, skillContent })),
        drainPod: (podId) => (podId === localPodId()
          ? orchestrator.drainPod(podId)
          : dispatch(podId, 'drain', { podId })),
      }

      return {
        api,
        teardown() {
          unsubscribe()
          for (const pending of pendingDispatches.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error('mesh-orchestrator: service torn down while a dispatch was still in flight'))
          }
          pendingDispatches.clear()
        },
      }
    },
  }
}

export {
  DEFAULT_ORCHESTRATOR_ENVELOPE_TYPE,
  DEFAULT_ORCHESTRATOR_DISPATCH_TIMEOUT_MS,
  DEFAULT_ACCESS_RESOURCE,
  RISKY_ACTIONS,
}
