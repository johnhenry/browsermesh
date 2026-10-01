/**
 * pod-host-service.mjs -- the gated, audited mesh service that speaks the
 * pod host protocol (issue #185's "hosted pods control surface", item 2).
 *
 * `@johnhenry/browsermesh-pod`'s `host-protocol.mjs` defines the eight
 * lane-agnostic verbs (`spawn`, `status`, `send`, `exec`, `snapshot`,
 * `restore`, `drain`, `list`), the podspec, the lifecycle state machine and
 * the wire envelopes -- as PLAIN DATA, so a Worker or a microVM host agent
 * can import it without pulling in this package. THIS file is the other
 * half: the place where those verbs meet `PeerRegistry.checkAccess()`, the
 * `AuditChain` and the orchestrator's `PLACEMENT_AUDIT` vocabulary, none of
 * which exist outside `browsermesh-apps`.
 *
 * Every later surface is a projection of this one service -- `mesh://`
 * routes, `meshctl` LLM tools, an external CLI, a supervisor. None of them
 * should re-implement access control, validation or audit; they should call
 * `createPodHostClient()` (or, in-process, the service's own `api`).
 *
 * ---------------------------------------------------------------------------
 * Three pieces:
 *
 *   - `createPodHostService({driver, ...})` -- a `MeshService` descriptor
 *     (`mesh-service.mjs`'s convention, same as `createMeshKvService()` /
 *     `createGrantLogService()`). Attach it with `attachService(peerNode,
 *     undefined, descriptor)`. It owns the HOST side: gate, validate,
 *     dispatch to the driver, respond, fan events out.
 *   - `createPodHostClient({peerNode})` -- the REQUESTER side: one method
 *     per verb, `requestId` correlation, a timeout, and remote
 *     `{code, message}` errors rethrown as `PodHostDriverError`.
 *   - `podHostRuntimePeer()` -- projects a host's `describe()` into the
 *     runtime-registry peer shape `orchestrator.mjs`'s
 *     `runtimePeerToComputeDescriptor()` already reads, so a host pod can
 *     be scored for placement without that function learning anything new.
 *
 * ---------------------------------------------------------------------------
 * ACCESS CONTROL. Every verb is checked as
 * `ctx.registry.checkAccess(pubKey, resource, verb)` -- i.e. the scope
 * grammar is `pod-host:spawn`, `pod-host:exec`, ... under the default
 * `resource` of `'pod-host'`. A host serving several tenants gives each its
 * own resource (`createPodHostService({resource: 'pod-host:tenant-a'})`)
 * rather than trying to express tenancy inside one scope.
 *
 * `describe` is DELIBERATELY NOT GATED, and travels on its own
 * `pod-host:describe` envelope rather than as a ninth verb. It returns only
 * what the host would publish in its announce metadata anyway (its lane,
 * its verb set, whether it can deploy); gating it would be security theatre
 * that also breaks discovery -- a peer has to be able to find out a host
 * exists before it can ask to be granted anything on it.
 *
 * ---------------------------------------------------------------------------
 * AUDIT. When an `auditChain` is supplied, the host writes the
 * `PLACEMENT_AUDIT` record types WP4 introduced (`orchestrator.mjs`):
 *
 *   placement_requested  a spawn request arrived (before the access check)
 *   placement_denied     checkAccess() said no, for any verb
 *   placement_started    spawn passed the gate and reached the driver
 *   placement_ready      the driver returned a live pod
 *   placement_evicted    a pod was drained (or snapshotted away)
 *
 * The REQUESTER side records its own `placement_requested`/`placement_ready`
 * /`placement_denied` through `MeshOrchestrator#recordPlacement()`; the two
 * sides are independent chains with independent authors, by design -- a
 * host's audit log is not evidence to the requester and vice versa.
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`, see `mesh-service.mjs`'s own module
 * doc comment for the convention):
 *
 *   - `pod-host:request`   `{from, verb, requestId}` -- a gated request was accepted.
 *   - `pod-host:denied`    `{from, verb, requestId, reason}` -- `checkAccess()` refused.
 *   - `pod-host:completed` `{from, verb, requestId, ok, code}` -- a response was sent.
 *   - `pod-host:event`     `{kind, data}` -- a driver lifecycle/log/exit event.
 *
 * No browser-only imports at module level.
 */

import {
  POD_HOST_REQUEST,
  POD_HOST_RESPONSE,
  POD_HOST_EVENT,
  POD_HOST_EVENT_KIND,
  POD_HOST_VERB,
  POD_HOST_VERBS,
  POD_HOST_ERROR,
  POD_LANE,
  PodHostDriverError,
  createHostRequest,
  createHostResponse,
  laneSupports,
  validateVerbRequest,
} from '@johnhenry/browsermesh-pod'
import { PLACEMENT_AUDIT } from './orchestrator.mjs'

/** Envelope type of a host-metadata request. Not one of the eight verbs -- see the module doc comment. */
export const POD_HOST_DESCRIBE = 'pod-host:describe'

/** Default ACL resource every verb is checked against. */
export const DEFAULT_POD_HOST_RESOURCE = 'pod-host'

/** Default `createPodHostClient()` request timeout, in ms. */
export const DEFAULT_POD_HOST_TIMEOUT_MS = 10_000

/**
 * The `shellBackend` each lane advertises, using the exact strings
 * `orchestrator.mjs`'s `runtimePeerToComputeDescriptor()` already maps
 * (`'vm-console'` -> the `vm_console` capability, `'pty'` -> `host_pty`).
 * Lanes with no shell advertise none, which is also why they answer `exec`
 * with `ELANE`.
 */
const LANE_SHELL_BACKEND = Object.freeze({
  [POD_LANE.MICROVM]: 'vm-console',
  [POD_LANE.NODE]: 'pty',
  [POD_LANE.ISOLATE]: null,
  [POD_LANE.BROWSER]: null,
})

/**
 * @typedef {object} PodHostDescription
 * @property {string|null} podId - The host pod's own mesh identity.
 * @property {string} lane - A `POD_LANE` value.
 * @property {string[]} verbs - Verbs this host actually serves.
 * @property {string[]} runtimeClasses - `[lane]` -- the `runtime:<class>`
 *   capability strings `ResourceScorer` matches on.
 * @property {string|null} shellBackend
 * @property {{canDeploy: boolean}} deploymentSupport
 * @property {string[]} capabilities
 * @property {string} resource - The ACL resource verbs are checked against.
 * @property {string|null} hostLabel
 */

/**
 * Project a `describe()` result into the runtime-registry peer shape
 * `orchestrator.mjs`'s `runtimePeerToComputeDescriptor()` reads, so a host
 * pod can be registered for placement scoring without that function
 * learning anything about pod hosts.
 *
 * KNOWN LIMITATION, worth stating plainly rather than papering over:
 * `runtimePeerToComputeDescriptor()` returns `null` for any peer whose
 * capabilities do not include `shell`/`exec`/`tools` (that is what it turns
 * into the `compute` capability every scored descriptor needs). An
 * ISOLATE-lane pod host has no `exec` by definition, so it produces no
 * compute descriptor today and can only be reached through this service
 * directly, not through `dispatchCompute()`. Fixing that means teaching the
 * orchestrator that "can spawn" is a kind of compute even without a shell
 * -- a change to WP4's scoring surface, deliberately out of scope here.
 *
 * @param {PodHostDescription} description
 * @param {object} [extra]
 * @param {object} [extra.resources] - Advertised resources, if any.
 * @param {string} [extra.hostedBy] - Set when this host is itself hosted.
 * @returns {object} A runtime-registry peer record.
 */
export function podHostRuntimePeer(description, extra = {}) {
  return {
    identity: { podId: description.podId },
    capabilities: [...description.capabilities],
    shellBackend: description.shellBackend ?? undefined,
    metadata: {
      runtimeClasses: [...description.runtimeClasses],
      deploymentSupport: { ...description.deploymentSupport },
      podHost: { verbs: [...description.verbs], resource: description.resource },
      ...(extra.resources ? { resources: extra.resources } : {}),
      ...(extra.hostedBy ? { hostedBy: extra.hostedBy } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------

/**
 * Build the `MeshService` descriptor that serves the pod host protocol for
 * one driver.
 *
 * @param {object} opts
 * @param {import('@johnhenry/browsermesh-pod').PodHostDriver} opts.driver
 *   The lane adapter. Must at minimum expose `lane` and `capabilities()`;
 *   any verb it omits is answered `ENOTSUP` without the driver being called.
 * @param {string} [opts.resource='pod-host'] - ACL resource every verb is
 *   checked against (`checkAccess(pubKey, resource, verb)`).
 * @param {object} [opts.auditChain] - Duck-typed `AuditChain`
 *   (`{append(authorPodId, operation, data, signFn)}`). When supplied, the
 *   host writes `PLACEMENT_AUDIT` records -- see the module doc comment.
 * @param {string} [opts.shellBackend] - Override the lane's default
 *   `shellBackend` in `describe()`.
 * @param {string} [opts.hostLabel] - Human-readable host name, echoed in
 *   `describe()` and in audit records.
 * @param {Function} [opts.onLog] - `(event, data) => void` debug logging.
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createPodHostService({
  driver,
  resource = DEFAULT_POD_HOST_RESOURCE,
  auditChain,
  onLog,
  hostLabel,
  shellBackend,
} = {}) {
  if (!driver || typeof driver !== 'object') {
    throw new Error('createPodHostService: driver is required')
  }
  if (typeof driver.lane !== 'string' || !driver.lane) {
    throw new Error('createPodHostService: driver.lane is required')
  }
  if (typeof driver.capabilities !== 'function') {
    throw new Error('createPodHostService: driver.capabilities() is required')
  }

  const log = onLog || (() => {})
  const lane = driver.lane
  // `undefined` means "use the lane default"; an explicit `null` means
  // "this host advertises no shell backend", which is a different claim.
  const advertisedShellBackend = shellBackend === undefined
    ? (LANE_SHELL_BACKEND[lane] ?? null)
    : shellBackend

  return {
    name: 'pod-host',

    attach(peerNode, ctx) {
      /** @type {string[]} The verbs this host answers; everything else is ELANE/ENOTSUP. */
      const verbs = (driver.capabilities().verbs || []).filter((verb) => POD_HOST_VERBS.includes(verb))

      /**
       * Which requesters are interested in which pod, for event fan-out.
       * A peer becomes interested by successfully addressing a pod by name
       * (spawning it, or driving any other named verb against it).
       * @type {Map<string, Set<string>>} pod name -> pubKeys
       */
      const interested = new Map()

      /**
       * @param {string} operation - A `PLACEMENT_AUDIT` value.
       * @param {object} data
       * @returns {Promise<void>}
       */
      async function recordAudit(operation, data) {
        if (!auditChain || typeof auditChain.append !== 'function') return
        const podId = peerNode.podId
        if (!podId) return
        try {
          await auditChain.append(
            podId,
            operation,
            { lane, resource, host: hostLabel ?? podId, ...data },
            (payload) => peerNode.wallet.sign(podId, payload),
          )
        } catch (err) {
          // Audit failures never break a verb -- same rule `PeerNode#audit()`
          // already applies to its own chain writes.
          log('pod-host:audit-failed', { operation, error: err?.message || String(err) })
        }
      }

      /** @returns {PodHostDescription} */
      function describe() {
        return {
          podId: peerNode.podId ?? null,
          lane,
          verbs: [...verbs],
          runtimeClasses: [lane],
          shellBackend: advertisedShellBackend,
          deploymentSupport: { canDeploy: verbs.includes(POD_HOST_VERB.SPAWN) },
          // `compute` is what `runtimePeerToComputeDescriptor()` derives
          // from `exec`; a host without exec deliberately does not claim it.
          capabilities: [
            'pod-host',
            ...(verbs.includes(POD_HOST_VERB.EXEC) ? ['exec'] : []),
          ],
          resource,
          hostLabel: hostLabel ?? null,
        }
      }

      /**
       * Refuse a verb before the driver is ever called: `ELANE` when the
       * lane structurally cannot, `ENOTSUP` when this driver simply does
       * not serve it.
       * @param {string} verb
       * @returns {PodHostDriverError|null}
       */
      function verbRefusal(verb) {
        // Lane first, driver second: a driver may not widen its lane by
        // declaring a verb the lane excludes (found by the browser-lane
        // extension driver, whose chrome.tabs.discard would otherwise have
        // slipped through as 'snapshot').
        if (!laneSupports(lane, verb)) {
          return new PodHostDriverError(POD_HOST_ERROR.ELANE, `lane '${lane}' cannot '${verb}'`, { verb, lane })
        }
        if (verbs.includes(verb) && typeof driver[verb] === 'function') return null
        return new PodHostDriverError(
          POD_HOST_ERROR.ENOTSUP,
          `host does not implement '${verb}'`,
          { verb, lane },
        )
      }

      /**
       * @param {string} verb
       * @param {object} value - The NORMALIZED payload from `validateVerbRequest()`.
       * @returns {Promise<*>}
       */
      async function dispatch(verb, value) {
        switch (verb) {
          case POD_HOST_VERB.SPAWN:
            return driver.spawn(value)
          case POD_HOST_VERB.STATUS:
            return driver.status(value.name)
          case POD_HOST_VERB.SEND:
            return driver.send(value.name, { to: value.to, payload: value.payload })
          case POD_HOST_VERB.EXEC:
            return driver.exec(value.name, value.command, { timeoutMs: value.timeoutMs })
          case POD_HOST_VERB.SNAPSHOT:
            return driver.snapshot(value.name)
          case POD_HOST_VERB.RESTORE:
            return driver.restore(value.name)
          case POD_HOST_VERB.DRAIN:
            return driver.drain(value.name, { cascade: value.cascade })
          case POD_HOST_VERB.LIST:
          default:
            return driver.list()
        }
      }

      /**
       * @param {string} pubKey
       * @param {string} requestId
       * @param {{ok: boolean, result?: *, error?: {code: string, message: string}}} body
       */
      async function respond(pubKey, requestId, body) {
        try {
          const response = createHostResponse(requestId, body)
          await ctx.sendTo(pubKey, POD_HOST_RESPONSE, {
            requestId: response.requestId,
            ok: response.ok,
            result: response.result,
            error: response.error,
            ts: response.ts,
          })
        } catch (err) {
          log('pod-host:respond-failed', { to: pubKey, requestId, error: err?.message || String(err) })
        }
      }

      /** @param {string} name @param {string} pubKey */
      function noteInterest(name, pubKey) {
        if (!name) return
        let set = interested.get(name)
        if (!set) {
          set = new Set()
          interested.set(name, set)
        }
        set.add(pubKey)
      }

      /**
       * The one untrusted-input path into this service.
       * @param {string} pubKey
       * @param {object} envelope
       */
      async function handleRequest(pubKey, envelope) {
        const requestId = envelope.requestId
        if (typeof requestId !== 'string' || !requestId) {
          log('pod-host:bad-envelope', { from: pubKey, reason: 'missing requestId' })
          return
        }

        if (envelope.type === POD_HOST_DESCRIBE) {
          // Ungated on purpose -- see the module doc comment.
          await respond(pubKey, requestId, { ok: true, result: describe() })
          return
        }

        const verb = envelope.verb
        if (!POD_HOST_VERBS.includes(verb)) {
          await respond(pubKey, requestId, {
            ok: false,
            error: { code: POD_HOST_ERROR.EINVAL, message: `unknown verb '${verb}'` },
          })
          return
        }

        try {
          const result = await gatedDispatch(pubKey, verb, envelope.payload ?? {}, { requestId })
          await respond(pubKey, requestId, { ok: true, result })
        } catch (err) {
          const driverError = PodHostDriverError.from(err)
          await respond(pubKey, requestId, { ok: false, error: driverError.toJSON() })
        }
      }

      /**
       * The ONE gated path from "a peer wants `verb`" to the driver: gate,
       * validate, lane/driver refusal, dispatch, with every audit record and
       * `ctx.emit()` this service makes. `handleRequest()` (the envelope
       * path) and `api.dispatch()` (what `pod-host-routes.mjs`'s `mesh://`
       * router and the HTTP gateway call) both go through here, so there is
       * exactly one copy of the gate.
       *
       * Resolves with the driver's result; rejects with a
       * `PodHostDriverError` (`EACCES`, `EINVAL`, `ELANE`, `ENOTSUP`, or
       * whatever the driver threw).
       *
       * @param {string} pubKey - The requesting peer.
       * @param {string} verb
       * @param {object} rawPayload - Un-normalized payload.
       * @param {{requestId?: string}} [opts]
       * @returns {Promise<*>}
       */
      async function gatedDispatch(pubKey, verb, rawPayload, { requestId = `local:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}` } = {}) {
        if (verb === POD_HOST_VERB.SPAWN) {
          await recordAudit(PLACEMENT_AUDIT.REQUESTED, {
            requester: pubKey, requestId, name: rawPayload?.name ?? null,
          })
        }

        // 1. Gate.
        const check = ctx.registry.checkAccess(pubKey, resource, verb)
        if (!check.allowed) {
          const reason = check.reason || 'denied'
          log('pod-host:denied', { from: pubKey, verb, reason })
          ctx.emit('pod-host:denied', { from: pubKey, verb, requestId, reason })
          await recordAudit(PLACEMENT_AUDIT.DENIED, { requester: pubKey, requestId, verb, reason })
          throw new PodHostDriverError(POD_HOST_ERROR.EACCES, `not authorized for '${resource}:${verb}'`, { verb, lane })
        }

        // 2. Validate (and normalize) before anything reaches the driver.
        const validated = validateVerbRequest(verb, rawPayload ?? {})
        if (!validated.ok) {
          ctx.emit('pod-host:completed', { from: pubKey, verb, requestId, ok: false, code: POD_HOST_ERROR.EINVAL })
          throw new PodHostDriverError(POD_HOST_ERROR.EINVAL, validated.errors.join('; '), { verb, lane })
        }

        // 3. Lane / driver capability.
        const refusal = verbRefusal(verb)
        if (refusal) {
          ctx.emit('pod-host:completed', { from: pubKey, verb, requestId, ok: false, code: refusal.code })
          throw refusal
        }

        ctx.emit('pod-host:request', { from: pubKey, verb, requestId })
        // Registered BEFORE the driver runs, not after: `spawn` emits its
        // own `cold -> booting -> registered` transitions from inside
        // `dispatch()`, and a requester that only became "interested" once
        // the call returned would miss every event about the pod it just
        // created.
        if (validated.value.name) noteInterest(validated.value.name, pubKey)
        if (verb === POD_HOST_VERB.SPAWN) {
          await recordAudit(PLACEMENT_AUDIT.STARTED, {
            requester: pubKey, requestId, name: validated.value.name,
          })
        }

        // 4. Dispatch.
        try {
          const result = await dispatch(verb, validated.value)
          if (verb === POD_HOST_VERB.SPAWN) {
            await recordAudit(PLACEMENT_AUDIT.READY, {
              requester: pubKey, requestId, name: validated.value.name, state: result?.state ?? null,
            })
          } else if (verb === POD_HOST_VERB.DRAIN || verb === POD_HOST_VERB.SNAPSHOT) {
            await recordAudit(PLACEMENT_AUDIT.EVICTED, {
              requester: pubKey, requestId, name: validated.value.name, verb, state: result?.state ?? null,
            })
          }
          ctx.emit('pod-host:completed', { from: pubKey, verb, requestId, ok: true, code: null })
          return result
        } catch (err) {
          const driverError = PodHostDriverError.from(err)
          log('pod-host:verb-failed', { from: pubKey, verb, code: driverError.code, error: driverError.message })
          ctx.emit('pod-host:completed', {
            from: pubKey, verb, requestId, ok: false, code: driverError.code,
          })
          throw driverError
        }
      }

      const unsubscribeIncoming = ctx.onIncomingData([POD_HOST_REQUEST, POD_HOST_DESCRIBE], (pubKey, envelope) => {
        handleRequest(pubKey, envelope).catch((err) => {
          log('pod-host:handler-failed', { from: pubKey, error: err?.message || String(err) })
        })
      })

      /**
       * Forward one driver event to every peer with an interest in the pod
       * it names, and publish it locally on the service's own event bus.
       * @param {object} event - A `createHostEvent()` envelope.
       */
      function forwardDriverEvent(event) {
        if (!event || typeof event !== 'object') return
        ctx.emit('pod-host:event', { kind: event.kind, data: event.data })
        const name = event.data?.name
        if (!name) return
        const targets = interested.get(name)
        if (!targets) return
        for (const pubKey of [...targets]) {
          ctx.sendTo(pubKey, POD_HOST_EVENT, { kind: event.kind, data: event.data, ts: event.ts })
            .catch((err) => {
              log('pod-host:event-forward-failed', { to: pubKey, error: err?.message || String(err) })
            })
        }
        // A pod that has exited has no further events; stop tracking it so
        // long-lived hosts don't accumulate an entry per pod ever spawned.
        if (event.kind === POD_HOST_EVENT_KIND.EXIT) interested.delete(name)
      }

      const unsubscribeDriver = typeof driver.onEvent === 'function'
        ? driver.onEvent(forwardDriverEvent)
        : null

      const api = {
        resource,
        lane,
        get verbs() { return [...verbs] },
        driver,
        describe,
        /** @param {object} [extra] @returns {object} */
        runtimePeer(extra) { return podHostRuntimePeer(describe(), extra) },
        /**
         * Gated dispatch on behalf of `pubKey` -- the same gate, validation,
         * lane check, audit and events the envelope path uses. This is what
         * other projections (`pod-host-routes.mjs`) must call instead of
         * `api.driver`, which stays raw and UNGATED.
         * @param {string} pubKey
         * @param {string} verb
         * @param {object} [payload]
         * @returns {Promise<*>}
         */
        dispatch(pubKey, verb, payload = {}) {
          if (!POD_HOST_VERBS.includes(verb)) {
            return Promise.reject(new PodHostDriverError(POD_HOST_ERROR.EINVAL, `unknown verb '${verb}'`, { verb, lane }))
          }
          return gatedDispatch(pubKey, verb, payload)
        },
      }

      return {
        api,
        teardown() {
          unsubscribeIncoming()
          if (typeof unsubscribeDriver === 'function') unsubscribeDriver()
          interested.clear()
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Requester side
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PodHostClient
 * @property {(hostPubKey: string, spec: object) => Promise<object>} spawn
 * @property {(hostPubKey: string, name: string) => Promise<object>} status
 * @property {(hostPubKey: string, name: string, payload: *, opts?: {to?: string}) => Promise<object>} send
 * @property {(hostPubKey: string, name: string, command: string[]|string, opts?: {timeoutMs?: number}) => Promise<{stdout: string, stderr: string, code: number}>} exec
 * @property {(hostPubKey: string, name: string) => Promise<object>} snapshot
 * @property {(hostPubKey: string, name: string) => Promise<object>} restore
 * @property {(hostPubKey: string, name: string, opts?: {cascade?: boolean}) => Promise<object>} drain
 * @property {(hostPubKey: string) => Promise<object[]>} list
 * @property {(hostPubKey: string) => Promise<PodHostDescription>} describe
 * @property {(fn: (hostPubKey: string, event: object) => void) => (() => void)} onEvent
 * @property {() => void} close
 */

/**
 * Build a client for talking to remote pod hosts over a `PeerNode`.
 *
 * One client talks to any number of hosts: every method takes the host's
 * pubKey as its first argument. Responses are correlated by the
 * `requestId` `createHostRequest()` generates, so several verbs can be in
 * flight against several hosts at once.
 *
 * A request that gets no response within `timeoutMs` rejects with
 * `PodHostDriverError` / `ETIMEDOUT`; a response carrying
 * `{ok: false, error}` rejects with that error's `{code, message}` rebuilt
 * as a `PodHostDriverError`, so `err.code === 'EACCES'` works the same
 * whether the refusal came from the local driver or six hops away.
 *
 * @param {object} opts
 * @param {object} [opts.peerNode] - The local `PeerNode`.
 * @param {import('./mesh-service.mjs').MeshServiceContext} [opts.ctx] -
 *   Alternative to `peerNode`, for a client built inside another service.
 * @param {number} [opts.timeoutMs=10000]
 * @param {Function} [opts.onLog]
 * @returns {PodHostClient}
 */
export function createPodHostClient({ peerNode, ctx, timeoutMs = DEFAULT_POD_HOST_TIMEOUT_MS, onLog } = {}) {
  const node = peerNode || ctx?.peerNode
  if (!node) throw new Error('createPodHostClient: peerNode (or ctx) is required')
  const log = onLog || (() => {})

  /** @type {Map<string, {resolve: Function, reject: Function, timer: *}>} */
  const pending = new Map()
  /** @type {Set<(hostPubKey: string, event: object) => void>} */
  const eventListeners = new Set()
  let closed = false

  const unsubscribe = node.onIncomingData((pubKey, data) => {
    if (!data || typeof data !== 'object') return

    if (data.type === POD_HOST_EVENT) {
      for (const fn of [...eventListeners]) {
        try {
          fn(pubKey, { type: POD_HOST_EVENT, kind: data.kind, data: data.data, ts: data.ts })
        } catch {
          // A throwing subscriber never breaks delivery to the others --
          // the same rule `mesh-service.mjs`'s event bus applies.
        }
      }
      return
    }

    if (data.type !== POD_HOST_RESPONSE) return
    const entry = pending.get(data.requestId)
    if (!entry) {
      // A late response to a request that already timed out. Dropping it
      // is correct: the caller has long since seen ETIMEDOUT.
      log('pod-host-client:unmatched-response', { from: pubKey, requestId: data.requestId })
      return
    }
    pending.delete(data.requestId)
    clearTimeout(entry.timer)
    if (data.ok) entry.resolve(data.result)
    else entry.reject(PodHostDriverError.from(data.error || { code: POD_HOST_ERROR.EINVAL, message: 'unknown error' }))
  })

  /**
   * @param {string} hostPubKey
   * @param {object} envelope - A request envelope with a `requestId`.
   * @returns {Promise<*>}
   */
  function roundTrip(hostPubKey, envelope) {
    if (closed) {
      return Promise.reject(new PodHostDriverError(POD_HOST_ERROR.EINVAL, 'pod host client is closed'))
    }
    if (!hostPubKey || typeof hostPubKey !== 'string') {
      return Promise.reject(new PodHostDriverError(POD_HOST_ERROR.EINVAL, 'hostPubKey is required'))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(envelope.requestId)
        reject(new PodHostDriverError(
          POD_HOST_ERROR.ETIMEDOUT,
          `pod host '${hostPubKey}' did not answer '${envelope.verb || envelope.type}' within ${timeoutMs}ms`,
          { host: hostPubKey, requestId: envelope.requestId },
        ))
      }, timeoutMs)
      // Never hold a Node process open for an in-flight request.
      if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()

      pending.set(envelope.requestId, { resolve, reject, timer })
      Promise.resolve(node.sendTo(hostPubKey, envelope)).catch((err) => {
        pending.delete(envelope.requestId)
        clearTimeout(timer)
        reject(PodHostDriverError.from(err))
      })
    })
  }

  /**
   * @param {string} hostPubKey
   * @param {string} verb
   * @param {object} [payload]
   * @returns {Promise<*>}
   */
  function call(hostPubKey, verb, payload = {}) {
    return roundTrip(hostPubKey, createHostRequest(verb, payload))
  }

  return {
    spawn(hostPubKey, spec) {
      return call(hostPubKey, POD_HOST_VERB.SPAWN, spec)
    },
    status(hostPubKey, name) {
      return call(hostPubKey, POD_HOST_VERB.STATUS, { name })
    },
    send(hostPubKey, name, payload, { to } = {}) {
      return call(hostPubKey, POD_HOST_VERB.SEND, to === undefined ? { name, payload } : { name, to, payload })
    },
    exec(hostPubKey, name, command, { timeoutMs: execTimeoutMs } = {}) {
      return call(
        hostPubKey,
        POD_HOST_VERB.EXEC,
        execTimeoutMs === undefined ? { name, command } : { name, command, timeoutMs: execTimeoutMs },
      )
    },
    snapshot(hostPubKey, name) {
      return call(hostPubKey, POD_HOST_VERB.SNAPSHOT, { name })
    },
    restore(hostPubKey, name) {
      return call(hostPubKey, POD_HOST_VERB.RESTORE, { name })
    },
    drain(hostPubKey, name, { cascade } = {}) {
      return call(hostPubKey, POD_HOST_VERB.DRAIN, cascade === undefined ? { name } : { name, cascade })
    },
    list(hostPubKey) {
      return call(hostPubKey, POD_HOST_VERB.LIST, {})
    },
    describe(hostPubKey) {
      // `describe` is not one of the eight verbs (see `POD_HOST_DESCRIBE`
      // and the module doc comment); it borrows `createHostRequest()` only
      // for its id generator, so both envelope families share one id space.
      const { requestId, ts } = createHostRequest(POD_HOST_VERB.LIST)
      return roundTrip(hostPubKey, { type: POD_HOST_DESCRIBE, requestId, ts })
    },
    onEvent(fn) {
      if (typeof fn !== 'function') return () => {}
      eventListeners.add(fn)
      return () => { eventListeners.delete(fn) }
    },
    close() {
      if (closed) return
      closed = true
      unsubscribe()
      eventListeners.clear()
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(new PodHostDriverError(POD_HOST_ERROR.EINVAL, 'pod host client closed before the response arrived'))
      }
      pending.clear()
    },
  }
}
