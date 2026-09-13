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
 * No browser-only imports at module level.
 */

/** Default scheme a descriptor's `createBackend` backend is registered under, if `backendScheme` is omitted. */
const DEFAULT_BACKEND_SCHEME = 'svc'

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
 * @returns {MeshServiceContext}
 */
function createServiceContext({ peerNode, network }) {
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
 * @returns {{ name: string, backendScheme: string|null, api: object|undefined, teardown: () => Promise<void> }}
 *   `api` is `descriptor.attach()`'s returned `{api}` field, if it returned
 *   that shape (undefined otherwise). `teardown()` calls whatever teardown
 *   function `descriptor.attach()` returned (bare-function or `{teardown}`
 *   shape). Does not (cannot -- see module doc comment) remove a registered
 *   `createBackend` backend from `network`.
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

  const ctx = createServiceContext({ peerNode, network })
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
    async teardown() {
      if (typeof attachTeardown === 'function') {
        await attachTeardown()
      }
    },
  }
}

export { DEFAULT_BACKEND_SCHEME }
