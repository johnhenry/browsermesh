/**
 * mesh-service.mjs -- the generic `MeshService` attach convention (Phase C
 * of the CloudStorage plan; see the plan's "Design decisions" section,
 * "`MeshService` is a minimal attach contract, not a `Backend` factory").
 *
 * This generalizes the pattern `mesh-sync.mjs` (`MeshSyncBinding`) and
 * `mesh-relay-host.mjs` (`MeshRelayHost`) already both hand-roll: subscribe
 * to `PeerNode.onIncomingData()`, filter on `envelope.type`, reply via
 * `node.sendTo()`. Rather than making every future mesh-native service
 * reimplement that filtering (and rather than forcing every such service to
 * produce a `browsermesh-netway` `Backend`, which doesn't generalize to
 * publish/subscribe-shaped services -- see the design review), this file
 * defines:
 *
 *   - `MeshService` -- a plain-object descriptor convention (NOT a class to
 *     instantiate): `{ name, attach(peerNode, ctx) -> teardown, createBackend?,
 *     backendScheme? }`.
 *   - `attachService(peerNode, network, descriptor)` -- the composition-root
 *     function that builds a `ctx` for a descriptor, calls `descriptor.attach()`,
 *     and (only if `descriptor.createBackend` is present) registers the
 *     returned `Backend` onto `network` under `descriptor.backendScheme`
 *     (default `'svc'`).
 *
 * `ctx` gives a service everything it needs without requiring it to know
 * `PeerNode` internals:
 *   - `ctx.onIncomingData(types, callback)` -- wraps `peerNode.onIncomingData()`,
 *     invoking `callback(pubKey, envelope)` only for envelopes whose `.type`
 *     matches `types` (a single string or an array of strings). Returns an
 *     unsubscribe function, exactly like the underlying `onIncomingData()`.
 *   - `ctx.sendTo(pubKey, type, payload)` -- wraps `peerNode.sendTo()`,
 *     merging `{ type, ...payload }` into the envelope sent, matching the
 *     `{ type: envelopeType, ...payload }` shape both `mesh-sync.mjs` and
 *     `mesh-relay-host.mjs` already send.
 *   - `ctx.registry` -- the node's `PeerRegistry`, for `checkAccess()`.
 *   - `ctx.peerNode` -- the raw `PeerNode`, for anything not covered above.
 *   - `ctx.network` -- the `VirtualNetwork` passed to `attachService()`, if
 *     any (services that don't use `createBackend` may still want direct
 *     `network.connect()` access, e.g. to reach another exposed service).
 *
 * `createBackend(ctx) -> Backend` is OPTIONAL on a descriptor. When present,
 * `attachService()` requires `network` to have been supplied (throws
 * otherwise -- a service that declares `createBackend` but is attached with
 * no `network` is a caller error, not a silent no-op) and calls
 * `network.addBackend(backendScheme, backend)`.
 *
 * Known limitation: `VirtualNetwork` (`browsermesh-netway`) has no
 * `removeBackend()` -- backend registration is permanent for the network's
 * lifetime, matching how `network.close()` (not per-backend removal) is
 * that class's only network-level teardown primitive today. `teardown()`
 * therefore only reverses what `descriptor.attach()` itself did (unsubscribe
 * from `onIncomingData()`, release any internal state); a registered
 * `Backend` stays routable on `network` until `network.close()`.
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`) -- Phase 1 of the mesh-KV-and-
 * observability plan (`mesh-kv-and-observability.md`, "Design decisions").
 *
 * `ctx.emit(event, data)` is a NEW hook, separate from and additional to
 * `onLog` (which every service already accepts as its own constructor
 * option and which stays exactly what it is: free-form, mostly error/
 * reject-path debug logging with no fixed vocabulary). `emit` is for a
 * small, curated set of MEANINGFUL STATE TRANSITIONS a service deliberately
 * chooses to publish for something else to consume (a dashboard,
 * `visualizations.mjs` in a later phase, a test assertion) -- not every
 * debug line. Event names follow the same `<service>:<kebab-description>`
 * grammar `onLog` already established (e.g. `grant-log:grant-applied`,
 * `chunk-replication:chunk-replicated`); each service documents its own
 * chosen vocabulary in its own module doc comment, exactly like `onLog`'s
 * existing per-service convention.
 *
 * The event bus lives on `attachService()`'s handle, NOT on
 * `createMeshNode()`'s aggregate: each attached service gets its own
 * independent bus (mirroring how each service already gets its own `ctx`),
 * and a caller that wants a node-wide view subscribes to each service's
 * handle individually (or a later composition layer, e.g. Phase 2's
 * observability bridge, does that fan-in) rather than this file inventing a
 * global event namespace up front.
 *
 * Subscription API, on the object `attachService()` returns:
 *   - `handle.on(event, callback)` -- `callback(data)` fires only for that
 *     exact `event` string. Returns an unsubscribe function.
 *   - `handle.onEvent(callback)` -- `callback(event, data)` fires for EVERY
 *     event this service emits, regardless of name (a "firehose"
 *     subscription, useful for a generic bridge/dashboard that doesn't want
 *     to enumerate every event name a service might ever add). Also returns
 *     an unsubscribe function.
 *
 * `ctx.emit()` fires SYNCHRONOUSLY: calling it invokes every
 * currently-registered `on()`/`onEvent()` callback immediately, in
 * registration order, before `emit()` returns -- there is no queueing or
 * microtask hop, matching `ctx.onIncomingData()`'s own synchronous dispatch
 * (a service reacting to an emitted event sees it happen exactly when the
 * emitting code ran, not "eventually").
 *
 * A THROWING SUBSCRIBER never crashes the emitting service, the shared
 * `onIncomingData()` dispatch loop, or any OTHER subscriber: each
 * callback invocation is individually wrapped in try/catch and swallowed.
 * This mirrors two already-established precedents in this exact family
 * rather than inventing a third convention: `mesh-rpc.mjs`'s `onRequest`
 * handler is caught and turned into a clean response so a throwing handler
 * can never become an unhandled rejection or break request/response
 * correlation for other in-flight callers, and `mesh-websocket.mjs`'s
 * `#dispatch()` (its `onopen`/`onmessage`/`onerror`/`onclose`/
 * `addEventListener()` fan-out) wraps every individual handler call in its
 * own try/catch specifically so "a throwing listener does not stop other
 * listeners" (that file's own comment, quoted because it's the same
 * property this bus needs). There is no `onLog` hook available inside the
 * bus itself to report a swallowed subscriber error -- `ctx.emit()` has no
 * log sink of its own, by design (see the module's overall `onLog`/`emit`
 * split above) -- a subscriber that needs to observe its own failures must
 * catch internally.
 *
 * `handle.teardown()` also stops all further event delivery: it clears
 * every registered `on()`/`onEvent()` subscriber and makes subsequent
 * `ctx.emit()` calls (if a torn-down service's own code somehow still calls
 * one) a silent no-op rather than reaching stale subscriber references.
 *
 * `createEventBus()` (below, exported) is the small, dependency-free helper
 * backing all of the above. It is exported so a composed, non-`MeshService`
 * class that has no `ctx` of its own -- e.g. `cloud-storage.mjs`'s
 * `CloudStorage`, which calls `attachService()` internally four times but
 * is not itself attached by anything -- can build a bus with the exact same
 * `{emit, on, onEvent, closeAll}` shape for its OWN higher-level events,
 * rather than that file reinventing a differently-shaped emitter.
 *
 * No browser-only imports at module level.
 */

/** Default scheme a descriptor's `createBackend` backend is registered under, if `backendScheme` is omitted. */
const DEFAULT_BACKEND_SCHEME = 'svc'

// ---------------------------------------------------------------------------
// Event bus -- backs ctx.emit() / attachService()'s handle.on()/.onEvent().
// See module doc comment's "Observability events" section for the full
// design (synchronous dispatch, throwing-subscriber isolation, teardown
// semantics). Exported standalone (not only used internally) so a composed,
// non-MeshService class with no ctx of its own can build one with the same
// shape -- see cloud-storage.mjs's own use of this for its higher-level
// put/get/grant events.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} EventBus
 * @property {(event: string, data?: object) => void} emit - Synchronous
 *   fan-out to every current `on(event, ...)` and `onEvent(...)` subscriber.
 *   No-op once `closeAll()` has been called.
 * @property {(event: string, callback: (data: object) => void) => (() => void)} on
 *   Subscribe to exactly one event name. Returns an unsubscribe function.
 * @property {(callback: (event: string, data: object) => void) => (() => void)} onEvent
 *   Subscribe to every event this bus ever emits, regardless of name.
 *   Returns an unsubscribe function.
 * @property {() => void} closeAll - Clears every subscriber and makes all
 *   future `emit()` calls silent no-ops. Idempotent.
 */

/**
 * @returns {EventBus}
 */
function createEventBus() {
  /** @type {Map<string, Set<Function>>} */
  const byEvent = new Map()
  /** @type {Set<Function>} */
  const wildcard = new Set()
  let closed = false

  /**
   * Invoke one subscriber, swallowing anything it throws -- see module doc
   * comment: a throwing subscriber must never crash the emitting service,
   * the shared dispatch loop, or any other subscriber. There is no log sink
   * available at this layer (see doc comment for why); a subscriber that
   * needs to observe its own failures must catch internally.
   * @param {Function} callback
   * @param {*[]} args
   */
  function safeInvoke(callback, args) {
    try {
      callback(...args)
    } catch {
      // Deliberately swallowed -- see this function's own doc comment.
    }
  }

  return {
    emit(event, data) {
      if (closed) return
      const specific = byEvent.get(event)
      if (specific) {
        for (const callback of [...specific]) safeInvoke(callback, [data, event])
      }
      for (const callback of [...wildcard]) safeInvoke(callback, [event, data])
    },
    on(event, callback) {
      if (typeof callback !== 'function') return () => {}
      let set = byEvent.get(event)
      if (!set) {
        set = new Set()
        byEvent.set(event, set)
      }
      set.add(callback)
      return () => { set.delete(callback) }
    },
    onEvent(callback) {
      if (typeof callback !== 'function') return () => {}
      wildcard.add(callback)
      return () => { wildcard.delete(callback) }
    },
    closeAll() {
      closed = true
      byEvent.clear()
      wildcard.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Typedefs (documentation only -- `MeshService` is a plain-object
// convention, not a class to instantiate)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} MeshServiceContext
 * @property {import('./peer-node.mjs').PeerNode} peerNode - The raw `PeerNode`.
 * @property {import('./peer-registry.mjs').PeerRegistry} registry - `peerNode.registry`, for `checkAccess()`.
 * @property {import('@johnhenry/browsermesh-netway').VirtualNetwork} [network] - The
 *   `VirtualNetwork` passed to `attachService()`, if any.
 * @property {(types: string|string[], callback: (pubKey: string, envelope: object) => void) => (() => void)} onIncomingData
 *   Envelope-type-filtered subscription. `callback` only fires for envelopes
 *   whose `.type` is in `types`. Returns an unsubscribe function.
 * @property {(pubKey: string, type: string, payload?: object) => Promise<void>} sendTo
 *   Sends `{ type, ...payload }` to `pubKey` via `peerNode.sendTo()`.
 * @property {(event: string, data?: object) => void} emit
 *   Publishes a curated, meaningful state-transition event for anything
 *   subscribed via `attachService()`'s returned handle (`handle.on()`/
 *   `handle.onEvent()`). Fires synchronously; a throwing subscriber is
 *   caught and never propagates back into the emitting service. See the
 *   module doc comment's "Observability events" section for the full
 *   design (separate from, and additional to, `onLog`).
 */

/**
 * @typedef {object} MeshService
 * @property {string} name - Unique service name (used as the lookup key in
 *   `createMeshNode({ services })`'s resulting `node.services` map).
 * @property {(peerNode: import('./peer-node.mjs').PeerNode, ctx: MeshServiceContext) => (MeshServiceAttachResult)} attach
 *   Wire the service to `peerNode`/`ctx`. May return either a bare
 *   `teardown()` function (the original shape, still supported) or
 *   `{ teardown?, api? }`, where `api` is whatever handle/instance the
 *   service wants exposed to its own caller later (e.g. a class instance
 *   with methods beyond attach/teardown) -- surfaced on `attachService()`'s
 *   returned handle as `.api`. Added after Phase D (`grant-log.mjs`) needed
 *   to hand back a live `GrantLog` instance and had no field for it; that
 *   phase's own `onReady(api)` callback workaround still works unmodified
 *   (this is additive, not breaking), but new services should prefer
 *   returning `{ teardown, api }` directly. NOTE: `attach()`'s return value
 *   is read synchronously by `attachService()` -- it is NOT awaited. A
 *   service needing async setup (e.g. signing that requires
 *   `crypto.subtle`) should expose that as a separately-awaitable method on
 *   `api`, not assume `attach()` itself is ever awaited by callers.
 * @property {(ctx: MeshServiceContext) => import('@johnhenry/browsermesh-netway').Backend} [createBackend]
 *   OPTIONAL. If present, `attachService()` registers the returned `Backend`
 *   onto the supplied `network` under `backendScheme`.
 * @property {string} [backendScheme='svc'] - URI scheme the `createBackend`
 *   backend is registered under. Only consulted when `createBackend` is present.
 */

/**
 * @typedef {(() => (void|Promise<void>))|{teardown?: (() => (void|Promise<void>)), api?: object}} MeshServiceAttachResult
 */

// ---------------------------------------------------------------------------
// ctx construction
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {import('./peer-node.mjs').PeerNode} opts.peerNode
 * @param {import('@johnhenry/browsermesh-netway').VirtualNetwork} [opts.network]
 * @param {EventBus} opts.eventBus
 * @returns {MeshServiceContext}
 */
function createServiceContext({ peerNode, network, eventBus }) {
  return {
    peerNode,
    registry: peerNode.registry,
    network,

    onIncomingData(types, callback) {
      const typeSet = new Set(Array.isArray(types) ? types : [types])
      return peerNode.onIncomingData((pubKey, data) => {
        if (!data || typeof data !== 'object' || !typeSet.has(data.type)) return
        callback(pubKey, data)
      })
    },

    async sendTo(pubKey, type, payload = {}) {
      await peerNode.sendTo(pubKey, { type, ...payload })
    },

    emit(event, data) {
      if (typeof event !== 'string' || !event) return
      eventBus.emit(event, data)
    },
  }
}

// ---------------------------------------------------------------------------
// attachService
// ---------------------------------------------------------------------------

/**
 * Attach one `MeshService` descriptor to `peerNode`.
 *
 * @param {import('./peer-node.mjs').PeerNode} peerNode
 * @param {import('@johnhenry/browsermesh-netway').VirtualNetwork} [network]
 *   Required only if `descriptor.createBackend` is present.
 * @param {MeshService} descriptor
 * @returns {{ name: string, backendScheme: string|null, api: object|undefined,
 *   on: (event: string, callback: (data: object) => void) => (() => void),
 *   onEvent: (callback: (event: string, data: object) => void) => (() => void),
 *   teardown: () => Promise<void> }}
 *   `api` is `descriptor.attach()`'s returned `{api}` field, if it returned
 *   that shape (undefined otherwise). `on()`/`onEvent()` subscribe to this
 *   service's `ctx.emit()` output -- see module doc comment's "Observability
 *   events" section. `teardown()` calls whatever teardown function
 *   `descriptor.attach()` returned (bare-function or `{teardown}` shape) and
 *   then stops all further event delivery via `on()`/`onEvent()`. Does not
 *   (cannot -- see module doc comment) remove a registered `createBackend`
 *   backend from `network`.
 */
export function attachService(peerNode, network, descriptor) {
  if (!peerNode) throw new Error('attachService: peerNode is required')
  if (!descriptor || typeof descriptor !== 'object') {
    throw new Error('attachService: descriptor is required')
  }
  if (typeof descriptor.attach !== 'function') {
    throw new Error(`attachService: descriptor '${descriptor.name || '(unnamed)'}'.attach() is required`)
  }
  if (!descriptor.name || typeof descriptor.name !== 'string') {
    throw new Error('attachService: descriptor.name is required')
  }

  const eventBus = createEventBus()
  const ctx = createServiceContext({ peerNode, network, eventBus })
  const attachResult = descriptor.attach(peerNode, ctx)

  let attachTeardown
  let api
  if (typeof attachResult === 'function') {
    attachTeardown = attachResult
  } else if (attachResult && typeof attachResult === 'object') {
    attachTeardown = attachResult.teardown
    api = attachResult.api
  }

  let backendScheme = null
  if (typeof descriptor.createBackend === 'function') {
    if (!network) {
      throw new Error(
        `attachService: descriptor '${descriptor.name}' has createBackend but no network was supplied ` +
        '(pass a VirtualNetwork as attachService\'s second argument)',
      )
    }
    backendScheme = descriptor.backendScheme || DEFAULT_BACKEND_SCHEME
    const backend = descriptor.createBackend(ctx)
    network.addBackend(backendScheme, backend)
  }

  return {
    name: descriptor.name,
    backendScheme,
    api,
    on(event, callback) {
      return eventBus.on(event, callback)
    },
    onEvent(callback) {
      return eventBus.onEvent(callback)
    },
    async teardown() {
      if (typeof attachTeardown === 'function') {
        await attachTeardown()
      }
      eventBus.closeAll()
    },
  }
}

export { DEFAULT_BACKEND_SCHEME, createEventBus }
