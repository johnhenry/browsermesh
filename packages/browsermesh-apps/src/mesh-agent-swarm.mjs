/**
 * mesh-agent-swarm.mjs -- issue #124: wraps `peer-agent-swarm.mjs`'s
 * `AgentSwarmCoordinator` as a `MeshService` (`mesh-service.mjs`, Phase C's
 * `attach()`/`ctx` convention).
 *
 * Issue #124 was originally filed claiming `AgentSwarmCoordinator` depends on
 * `swarm.mjs`'s SWIM coordination (#88, wired as `mesh-swarm.mjs`) and
 * `peer-compute.mjs` (#118, wired as `mesh-compute.mjs`). Grounded
 * investigation found neither is true: `AgentSwarmCoordinator` has its own,
 * completely separate, self-invented `SwarmInstance`/`SubTask`
 * membership/task model with zero code dependency on `swarm.mjs`'s
 * `SwarmMember`/`SwarmTask`/`LeaderElection`/`TaskDistributor`, and it
 * imports nothing from `peer-compute.mjs`. This file does not compose either
 * of those services -- it is a fresh, self-contained wiring job.
 *
 * ---------------------------------------------------------------------------
 * WHAT `AgentSwarmCoordinator` ITSELF DOES AND DOES NOT DO -- read directly
 * off its constructor and `executeSubTask()`:
 *
 *   - `agentProxy.chat(podId, message) -> Promise<string>` is a required
 *     constructor dependency (`AgentSwarmCoordinator` throws immediately if
 *     it's missing/falsy) -- the real "execute work" boundary, directly
 *     analogous to `peer-compute.mjs`'s required `executeFn`/
 *     `peer-verification.mjs`'s required `executeFn` (issue #86's resolved
 *     "bring-your-own executor, required, no default shipped" design).
 *   - `createSwarm()`/`decompose()`/`assign()` are pure local bookkeeping --
 *     `assign()` in particular just decides, from the swarm's own `members`
 *     list and `strategy`, who each subtask's `assignee` is. None of it does
 *     any network I/O.
 *   - `executeSubTask(swarmId, subtaskId, assignee)` is the ONE real
 *     network-relevant operation: it calls
 *     `this.#agentProxy.chat(assignee, subtask.description)` directly,
 *     UNCONDITIONALLY -- it never checks whether `assignee` is this node or
 *     some other one. In the original, single-node code (a single
 *     `AgentSwarmCoordinator` + a single `agentProxy` that happens to be able
 *     to `chat()` with several locally-known `podId`s, e.g. several ClawserPod
 *     agents in one process), that's fine: every `assignee` is reachable
 *     through the same local `agentProxy`. In a real mesh deployment,
 *     `assignee` is frequently a REMOTE peer's podId -- so today's code, as
 *     written, is fundamentally single-node-only: it has no notion
 *     whatsoever of "this assignee lives on another machine, go get the
 *     result from them over the network" versus "this assignee is local."
 *
 * ---------------------------------------------------------------------------
 * THE WIRING APPROACH THIS FILE TAKES -- narrower than `mesh-compute.mjs`'s/
 * `mesh-verification.mjs`'s "wrap the injected `scheduler`" shape, and
 * deliberately so:
 *
 * `AgentSwarmCoordinator` funnels ALL of its real work through exactly one
 * injected seam: `agentProxy.chat(podId, message)`. Rather than
 * reimplementing `executeSubTask()`'s status bookkeeping (`'running'` ->
 * `'completed'`/`'failed'`, `st.result`, the `subtask-complete` event, the
 * `swarm.timeoutMs` race) OUTSIDE the class, this file supplies the
 * coordinator with a `meshAgentProxy` wrapper around the caller's real
 * `agentProxy`: `meshAgentProxy.chat(podId, message)` checks whether `podId`
 * is THIS node's own `peerNode.podId` --
 *
 *   - if so, it calls the caller-supplied local `agentProxy.chat()` directly
 *     -- no network round-trip is ever forced for a self-assigned subtask;
 *   - otherwise, it sends a real `'agent-swarm-request'` envelope to `podId`
 *     over `ctx.sendTo()` and awaits a matching `'agent-swarm-response'`
 *     reply, exactly the request/correlation-id/timeout shape
 *     `mesh-compute.mjs`'s default `scheduler.dispatch()` already
 *     establishes.
 *
 * Since `executeSubTask()` already calls `this.#agentProxy.chat(assignee,
 * ...)` for every subtask regardless of who `assignee` is, injecting this one
 * wrapper is sufficient to make `executeSubTask()` itself correctly local- or
 * remote-dispatch -- no other method needs touching, and none of
 * `AgentSwarmCoordinator`'s own status/event/timeout logic is duplicated.
 *
 * ---------------------------------------------------------------------------
 * LOCAL/ADMIN vs. PEER-INITIATED:
 *
 *   - `api.createSwarm()`/`api.decompose()`/`api.assign()`/
 *     `api.executeSubTask()`/`api.collectResults()`/`api.getSwarm()`/
 *     `api.listSwarms()`/`api.disbandSwarm()` are all LOCAL calls: this
 *     node's own operator/application code driving a swarm it owns. Nothing
 *     about calling any of these requires anything from a remote peer first
 *     -- `executeSubTask()` may, internally, reach out to a peer (see above),
 *     but the decision to call it at all is always local.
 *   - Receiving an `'agent-swarm-request'` FROM a peer -- i.e., being asked
 *     to run `agentProxy.chat()` on THIS node's behalf, because some other
 *     node's coordinator assigned a subtask to this podId -- is the
 *     genuinely PEER-INITIATED action, and the one that needs an
 *     authorization check: before this node ever runs its local
 *     `agentProxy.chat()` for a remote requester, it gates the request
 *     through `ctx.registry.checkAccess(fromPubKey, accessResource,
 *     accessAction)` (default resource/action: `'agent-swarm'`/`'execute'`),
 *     the same `registry.checkAccess()` gate `mesh-compute.mjs`/
 *     `mesh-verification.mjs`/`chunk-replication.mjs`/`mesh-kv.mjs` already
 *     established for "a peer wants this node to do something on its
 *     behalf." A denied peer gets an explicit `{error: 'access denied'}`
 *     response (not a silent drop) -- the requesting side's `chat()` Promise
 *     is already open and waiting, so silently dropping would just make an
 *     unauthorized peer indistinguishable from a slow or dead one, exactly
 *     the reasoning `mesh-compute.mjs`'s/`mesh-verification.mjs`'s own header
 *     comments already document ("WHY AN EXPLICIT DENIAL RESPONSE").
 *
 * ---------------------------------------------------------------------------
 * `agentProxy` -- REQUIRED, NOT PROVIDED BY THIS FILE, AND CHECKED TWICE.
 * Unlike `mesh-compute.mjs`'s `executeFn`/`mesh-verification.mjs`'s
 * `executeFn` (each OPTIONAL at their respective `createXService()` layer,
 * since a node can legitimately submit-only without ever answering), a
 * usable `agentProxy` is unconditionally required here: `AgentSwarmCoordinator`
 * itself throws in its own constructor if `agentProxy` is falsy, and EVERY
 * real operation this service offers -- including a purely local,
 * self-assigned `executeSubTask()` with no peer involved at all -- ultimately
 * calls into it. Because this file always hands `AgentSwarmCoordinator` its
 * own always-truthy `meshAgentProxy` wrapper (never the caller's raw
 * `agentProxy` directly), that class's own truthy check can never catch a
 * missing caller-supplied `agentProxy` -- so `createAgentSwarmService()`
 * checks for it explicitly and throws immediately, with a clear message,
 * before ever constructing anything. `mesh-bootstrap.mjs`'s
 * `{enableAgentSwarm, agentSwarmOptions}` wiring ALSO checks this up front
 * (mirroring `enableCompute`'s/`enableTerminal`'s established
 * required-dependency check), so a caller going through `createMeshNode()`
 * gets the same clear failure before any service is attached. No default
 * `agentProxy` implementation is built anywhere in this file -- issue #86's
 * resolved "bring-your-own executor" decision applies here exactly as it does
 * for compute/verification/terminal.
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`, see `mesh-service.mjs`'s module doc
 * comment for the full convention). `AgentSwarmCoordinator`'s own
 * pre-existing `on`/`off` surface is bridged through verbatim, prefixed
 * `agent-swarm:`:
 *
 *   - `agent-swarm:created`         -- `{swarmId, goal, leader}`.
 *   - `agent-swarm:task-assigned`   -- `{swarmId, subtaskId, assignee}`.
 *   - `agent-swarm:subtask-complete` -- `{swarmId, subtaskId, assignee, result}`.
 *   - `agent-swarm:completed`       -- `{swarmId, merged, individual}`.
 *   - `agent-swarm:disbanded`       -- `{swarmId}`.
 *
 * Plus this file's own, for the wire layer (mirroring `mesh-compute.mjs`'s
 * `compute:chunk-served`/`compute:chunk-request-denied`):
 *
 *   - `agent-swarm:execute-served`  `{from, requestId, ok}` -- this node, AS
 *     THE ASSIGNEE, answered an authorized `'agent-swarm-request'` (`ok:
 *     true` if the local `agentProxy.chat()` succeeded, `false` if it threw).
 *   - `agent-swarm:execute-request-denied` `{from, requestId, reason}` -- an
 *     inbound `'agent-swarm-request'` was rejected before `agentProxy.chat()`
 *     ever ran (`reason`: `'access_denied'`).
 *
 * No browser-only imports at module level.
 */

import { AgentSwarmCoordinator } from './peer-agent-swarm.mjs'

/** Shared envelope `type` for both request/response directions (tagged by `kind`), mirroring `mesh-compute.mjs`'s `'mesh-compute'` shape. */
const DEFAULT_AGENT_SWARM_ENVELOPE_TYPE = 'mesh-agent-swarm'

/** How long the remote-dispatch path of `meshAgentProxy.chat()` waits for a matching `'agent-swarm-response'` before giving up. Independent of (and typically ⩽) `AgentSwarmCoordinator`'s own internal `swarm.timeoutMs` race around the whole `agentProxy.chat()` call -- whichever fires first wins; this one exists purely so a never-answering peer's pending entry is always eventually cleaned up. */
const DEFAULT_AGENT_SWARM_DISPATCH_TIMEOUT_MS = 30000

/** Default `resource`/`action` pair checked via `ctx.registry.checkAccess(fromPubKey, resource, action)` before honoring an inbound `'agent-swarm-request'`. */
const DEFAULT_AGENT_SWARM_ACCESS_RESOURCE = 'agent-swarm'
const DEFAULT_AGENT_SWARM_ACCESS_ACTION = 'execute'

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) wrapping
 * `AgentSwarmCoordinator`. See this file's module doc comment for the full
 * design writeup (what's local/admin-only vs. peer-initiated, why
 * `agentProxy` is required and checked here directly rather than left to
 * `AgentSwarmCoordinator`'s own constructor check, the local-vs-remote
 * `meshAgentProxy` wrapper).
 *
 * @param {object} opts
 * @param {{chat: (podId: string, message: string) => Promise<string>}} opts.agentProxy
 *   REQUIRED. Called to actually run a chat turn for an agent hosted on THIS
 *   node -- both for purely local, self-assigned subtasks (called directly,
 *   no network) and for authorized inbound `'agent-swarm-request'`s from a
 *   remote peer whose coordinator assigned a subtask to this node (called
 *   after `ctx.registry.checkAccess()` authorizes the requester). This
 *   function throws immediately if omitted -- see module doc comment.
 * @param {number} [opts.dispatchTimeoutMs=30000] - How long the remote-dispatch
 *   path of `meshAgentProxy.chat()` waits for an `'agent-swarm-response'`.
 * @param {string} [opts.envelopeType='mesh-agent-swarm']
 * @param {string} [opts.accessResource='agent-swarm'] - `resource` passed to
 *   `ctx.registry.checkAccess()` for inbound `'agent-swarm-request'`s.
 * @param {string} [opts.accessAction='execute'] - `action` passed to
 *   `ctx.registry.checkAccess()` for inbound `'agent-swarm-request'`s.
 * @param {Function} [opts.onLog]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createAgentSwarmService({
  agentProxy,
  dispatchTimeoutMs = DEFAULT_AGENT_SWARM_DISPATCH_TIMEOUT_MS,
  envelopeType = DEFAULT_AGENT_SWARM_ENVELOPE_TYPE,
  accessResource = DEFAULT_AGENT_SWARM_ACCESS_RESOURCE,
  accessAction = DEFAULT_AGENT_SWARM_ACCESS_ACTION,
  onLog,
} = {}) {
  if (!agentProxy) {
    throw new Error(
      'createAgentSwarmService: agentProxy is required (an object implementing ' +
      'async chat(podId, message) -> string -- see peer-agent-swarm.mjs\'s ' +
      'AgentSwarmCoordinator). No default agentProxy is provided by this package.',
    )
  }
  const log = onLog || (() => {})

  return {
    name: 'agent-swarm',

    attach(peerNode, ctx) {
      // -- Wire protocol state -------------------------------------------
      let reqSeq = 0
      const nextRequestId = () => `${peerNode.podId}:${Date.now()}:${++reqSeq}`

      /** @type {Map<string, {resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>}>} */
      const pendingDispatches = new Map()

      // -- meshAgentProxy: the one seam AgentSwarmCoordinator calls through
      // for every real operation. Local-assignment (podId === this node's
      // own podId) never touches the network -- see module doc comment.
      const meshAgentProxy = {
        async chat(podId, message) {
          if (podId === peerNode.podId) {
            return agentProxy.chat(podId, message)
          }

          const requestId = nextRequestId()
          const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              pendingDispatches.delete(requestId)
              reject(new Error(`mesh-agent-swarm: dispatch to ${podId} timed out after ${dispatchTimeoutMs}ms`))
            }, dispatchTimeoutMs)
            pendingDispatches.set(requestId, { resolve, reject, timer })
          })

          ctx.sendTo(podId, envelopeType, { kind: 'agent-swarm-request', requestId, message }).catch((err) => {
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

      const coordinator = new AgentSwarmCoordinator({
        agentProxy: meshAgentProxy,
        onLog: (level, msg) => log('mesh-agent-swarm:internal', { level, msg }),
      })

      // Bridge AgentSwarmCoordinator's own pre-existing on()/off() events
      // through ctx.emit() -- see module doc comment's "Observability
      // events" section.
      const bridgedEvents = [
        'created', 'task-assigned', 'subtask-complete', 'completed', 'disbanded',
      ]
      const bridgeHandlers = bridgedEvents.map((event) => {
        const handler = (data) => ctx.emit(`agent-swarm:${event}`, data)
        coordinator.on(event, handler)
        return [event, handler]
      })

      // -- Inbound wire handling ------------------------------------------
      async function handleAgentSwarmRequest(fromPubKey, msg) {
        const { requestId, message } = msg

        const access = ctx.registry.checkAccess(fromPubKey, accessResource, accessAction)
        if (!access.allowed) {
          ctx.emit('agent-swarm:execute-request-denied', { from: fromPubKey, requestId, reason: 'access_denied' })
          await ctx.sendTo(fromPubKey, envelopeType, { kind: 'agent-swarm-response', requestId, error: 'access denied' }).catch((err) => {
            log('mesh-agent-swarm:response-send-failed', { to: fromPubKey, requestId, error: err?.message || String(err) })
          })
          return
        }

        let response
        try {
          const result = await agentProxy.chat(peerNode.podId, message)
          response = { kind: 'agent-swarm-response', requestId, result }
        } catch (err) {
          response = { kind: 'agent-swarm-response', requestId, error: err?.message || String(err) }
        }

        try {
          await ctx.sendTo(fromPubKey, envelopeType, response)
          ctx.emit('agent-swarm:execute-served', { from: fromPubKey, requestId, ok: !response.error })
        } catch (err) {
          log('mesh-agent-swarm:response-send-failed', { to: fromPubKey, requestId, error: err?.message || String(err) })
        }
      }

      function handleAgentSwarmResponse(msg) {
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
        if (msg.kind === 'agent-swarm-request') {
          handleAgentSwarmRequest(fromPubKey, msg).catch((err) => {
            log('mesh-agent-swarm:request-handling-failed', { from: fromPubKey, requestId: msg.requestId, error: err?.message || String(err) })
          })
        } else if (msg.kind === 'agent-swarm-response') {
          handleAgentSwarmResponse(msg)
        }
      })

      const api = {
        /**
         * @param {string} goal
         * @param {object} [opts]
         * @returns {Promise<import('./peer-agent-swarm.mjs').SwarmInstance>}
         */
        createSwarm: (goal, createOpts) => coordinator.createSwarm(goal, createOpts),

        /**
         * @param {string} swarmId
         * @param {Function} [decomposer]
         * @returns {Promise<import('./peer-agent-swarm.mjs').SubTask[]>}
         */
        decompose: (swarmId, decomposer) => coordinator.decompose(swarmId, decomposer),

        /** @param {string} swarmId */
        assign: (swarmId) => coordinator.assign(swarmId),

        /**
         * @param {string} swarmId
         * @param {string} subtaskId
         * @param {string} assignee
         * @returns {Promise<{result: string, success: boolean, error?: string}>}
         */
        executeSubTask: (swarmId, subtaskId, assignee) => coordinator.executeSubTask(swarmId, subtaskId, assignee),

        /**
         * @param {string} swarmId
         * @param {Function} [mergeFn]
         */
        collectResults: (swarmId, mergeFn) => coordinator.collectResults(swarmId, mergeFn),

        /** @param {string} id */
        getSwarm: (id) => coordinator.getSwarm(id),

        listSwarms: () => coordinator.listSwarms(),

        /** @param {string} swarmId */
        disbandSwarm: (swarmId) => coordinator.disbandSwarm(swarmId),
      }

      return {
        api,
        teardown() {
          for (const [event, handler] of bridgeHandlers) coordinator.off(event, handler)
          unsubscribe()
          for (const pending of pendingDispatches.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error('mesh-agent-swarm: service torn down while a dispatch was still in flight'))
          }
          pendingDispatches.clear()
        },
      }
    },
  }
}

export {
  DEFAULT_AGENT_SWARM_ENVELOPE_TYPE,
  DEFAULT_AGENT_SWARM_DISPATCH_TIMEOUT_MS,
  DEFAULT_AGENT_SWARM_ACCESS_RESOURCE,
  DEFAULT_AGENT_SWARM_ACCESS_ACTION,
}
