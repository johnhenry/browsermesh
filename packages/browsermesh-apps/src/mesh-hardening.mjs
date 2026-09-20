/**
 * mesh-hardening.mjs -- wires `@johnhenry/browsermesh-core`'s hardening.mjs
 * primitives (`RetryWithBackoff`, `TransportFailover`, `TransportMetrics`,
 * `MetricsRegistry`) around the `MeshTransportNegotiator` `mesh-bootstrap.mjs`
 * constructs, so a transient WebRTC/ICE negotiation failure (the class of
 * problem issue #26 documented, since fixed upstream via PR #53, but not
 * the only source of transient failure a real mesh will see) is retried
 * with backoff instead of failing `connectToPeer()` outright.
 *
 * ## The seam
 * `PeerNode.connectToPeer(pubKey, endpoints, auth)` (peer-node.mjs) calls
 * exactly one method on whatever `transportNegotiator` it was constructed
 * with: `this.#transportNeg.negotiate(endpoints, auth)`. That is the only
 * method `hardening.mjs`'s primitives need to intercept, and (per
 * `hardening.mjs`'s own JSDoc `@example` on `RetryWithBackoff` --
 * `retry.execute(() => negotiator.negotiate(endpoints))` -- and on
 * `TransportFailover` -- `new TransportFailover({ negotiator, endpoints,
 * ... })` / `failover.connect()`, both of which call
 * `negotiator.negotiate(endpoints, auth)` internally) it is exactly what
 * these primitives were built to wrap. `createHardenedNegotiator()` below
 * returns an object shaped like a negotiator (just `negotiate()`) that is a
 * drop-in replacement wherever `new PeerNode({ transportNegotiator })`
 * expects one -- `registerAdapter()` keeps being called on the real,
 * wrapped `MeshTransportNegotiator` directly (`mesh-bootstrap.mjs` does
 * this, unchanged), since mutating that real instance is exactly what the
 * wrapper's closed-over `negotiator` reference sees at call time regardless
 * of registration order.
 *
 * ## What's wired, and how
 *  - `RetryWithBackoff`: one instance per distinct `endpoints` shape (see
 *    `#endpointsKey()`), lazily created on first `negotiate()` call and
 *    reused after that. Scoping the circuit breaker per-endpoints (in
 *    practice, per-peer -- `webrtc-negotiator.mjs`'s convention makes
 *    `endpoints.webrtc` the remote peer's podId) rather than sharing one
 *    instance node-wide is a deliberate choice: a single unreachable peer
 *    (bad NAT, offline) should trip *that* peer's circuit breaker, not
 *    start rejecting `connectToPeer()` calls to every other, perfectly
 *    reachable peer.
 *  - `TransportFailover`: likewise one instance per endpoints key, reused
 *    across calls -- `.connect()` on the first call, `.failover()` on any
 *    subsequent call once a transport is already active (a caller invoking
 *    `connectToPeer()` again for a peer that already has a live transport
 *    is asking for a fresh one), so `.failedTypes`/`.activeTransport`
 *    remain meaningful for a peer across repeated connection attempts.
 *  - `TransportMetrics` / `MetricsRegistry`: negotiation latency and
 *    negotiation errors are recorded per endpoints key; once a transport is
 *    live, its `send()` and inbound `onMessage()` are additionally
 *    instrumented for byte/message counters (errors surfaced via
 *    `onError()` too, where the transport supports it).
 *
 * ## What's *not* wired here, and why
 *  - `TransportHealthCheck`: a genuine ping/pong liveness probe needs a
 *    keepalive envelope type on `PeerNode`'s own dispatch bus (mirroring
 *    `mesh-sync.mjs`'s `envelopeType` convention) so the *far* side actually
 *    answers pings -- that's a real protocol addition (both peers need to
 *    speak it), out of scope for this pass. Wiring `TransportHealthCheck`
 *    here without a real peer-side pong responder would just be a timer
 *    that always reports "unhealthy" after `maxMissed` misses no matter how
 *    healthy the connection actually is -- worse than not wiring it.
 *  - `ConnectionPool`: as of issue #116, `PeerNode` *can* hold more than one
 *    active session per peer (`connectToPeer()`/`adoptIncomingSession()`
 *    both take a `connectionId`, tagging the `#sessions` entry they create
 *    in peer-node.mjs), but those sessions are still named/addressed
 *    explicitly by the caller, not pooled/acquired opaquely -- `sendTo()`
 *    picks either "most recently created" or an exact `connectionId`, never
 *    "whichever idle one `ConnectionPool.acquire()` hands back". Wiring
 *    `ConnectionPool` itself here would mean layering a second, different
 *    connection-selection model (acquire/release semantics for reused,
 *    anonymous pooled connections) on top of the named-session model
 *    `PeerNode` now has, for no concretely-needed benefit yet.
 * Both remain exported from `@johnhenry/browsermesh-core` for callers who
 * want to build that wiring themselves.
 *
 * ## Multiple connections per peer (issue #116)
 * `endpointsKey(endpoints, auth)` folds `auth.connectionId` into the key
 * (when present) precisely so two `PeerNode.connectToPeer()` calls for the
 * same peer with *different* `connectionId`s get their own `RetryWithBackoff`
 * / `TransportFailover` / metrics instance apiece, each independently
 * `.connect()`-ing rather than the second call silently reusing the first's
 * already-active `TransportFailover` and `.failover()`-ing (renegotiating)
 * *that* connection instead of ever establishing its own. Calls that never
 * pass `auth.connectionId` are unaffected -- same key as before this was
 * added.
 *
 * No browser-only imports at module level.
 */

// @johnhenry/browsermesh-core (an optional peerDependency) is imported
// lazily inside createHardenedNegotiator() below, not eagerly here -- so
// this module doesn't force it on every consumer of this package's
// top-level `.` entrypoint. See the CHANGELOG entry documenting this fix.

const DEFAULT_METRICS_KEY = 'unknown'

/**
 * Derive a stable key for an `endpoints` map (`{ webrtc: 'peer-pod-id', ... }`)
 * to scope per-peer `RetryWithBackoff`/`TransportFailover`/metrics state.
 *
 * Exported (not just used internally) so `mesh-keepalive.mjs` (issue #110)
 * can derive the SAME key to look up this file's `failovers` map for a given
 * peer's pubKey -- see that file's own header comment for why this is a
 * best-effort, webrtc-convention-specific correlation rather than a real
 * shared index keyed by pubKey. `mesh-keepalive.mjs` only ever calls this
 * with one argument, correlating against the peer's `DEFAULT_CONNECTION_ID`
 * connection specifically -- see this file's header comment on `auth`, below.
 *
 * @param {object} [endpoints]
 * @param {object} [auth] - If `auth.connectionId` is present (issue #116:
 *   `PeerNode.connectToPeer()`'s `auth.connectionId`, threaded straight
 *   through to `negotiate(endpoints, auth)`), it's folded into the key so
 *   independent connections to the same peer get independent retry/failover/
 *   metrics state. Omitting it (or `connectionId`) reproduces the exact key
 *   this function returned before that parameter existed.
 * @returns {string}
 */
export function endpointsKey(endpoints, auth) {
  if (!endpoints) return DEFAULT_METRICS_KEY
  const values = Object.keys(endpoints)
    .sort()
    .map((type) => `${type}=${endpoints[type]}`)
  const base = values.length > 0 ? values.join('&') : DEFAULT_METRICS_KEY
  return auth?.connectionId ? `${base}::connectionId=${auth.connectionId}` : base
}

/**
 * Best-effort byte-length estimate for a `send()`/`onMessage()` payload,
 * which may be a string (the common case -- `PeerNode.sendTo()`'s own JSDoc
 * example calls it with `JSON.stringify(...)`), a typed array/ArrayBuffer,
 * or a plain object.
 *
 * @param {*} data
 * @returns {number}
 */
function estimateByteLength(data) {
  if (typeof data === 'string') return data.length
  if (data && typeof data.byteLength === 'number') return data.byteLength
  try {
    return JSON.stringify(data)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * Instrument a live transport's `send()`/`onMessage()`/`onError()` (where
 * present) to feed a `TransportMetrics` instance. Idempotent -- a transport
 * is only instrumented once even if handed back through `negotiate()` more
 * than once (e.g. `TransportFailover` returning the same still-open
 * transport is not expected, but this guards it cheaply either way).
 *
 * @param {object} transport
 * @param {import('@johnhenry/browsermesh-core').TransportMetrics} metrics
 * @returns {object} The same transport, instrumented in place.
 */
function instrumentTransport(transport, metrics) {
  if (!transport || transport.__hardeningInstrumented) return transport
  transport.__hardeningInstrumented = true

  if (typeof transport.send === 'function') {
    const originalSend = transport.send.bind(transport)
    transport.send = (data) => {
      try {
        const result = originalSend(data)
        metrics.recordSend(estimateByteLength(data))
        return result
      } catch (err) {
        metrics.recordError()
        throw err
      }
    }
  }

  if (typeof transport.onMessage === 'function') {
    transport.onMessage((data) => metrics.recordReceive(estimateByteLength(data)))
  }

  if (typeof transport.onError === 'function') {
    transport.onError(() => metrics.recordError())
  }

  return transport
}

/**
 * Wrap a real `MeshTransportNegotiator` with retry/backoff + failover +
 * metrics (`@johnhenry/browsermesh-core`'s hardening.mjs), returning an
 * object shaped like a negotiator -- `negotiate(endpoints, auth)` is the
 * only method `PeerNode.connectToPeer()` calls, so this is a drop-in
 * replacement for `new PeerNode({ transportNegotiator })`.
 *
 * @param {object} opts
 * @param {import('@johnhenry/browsermesh-transport').MeshTransportNegotiator} opts.negotiator
 *   The real negotiator (adapters are still registered on this directly).
 * @param {object} [opts.retryOptions] - Passed to each per-endpoints-key
 *   `new RetryWithBackoff()` (maxRetries/baseDelayMs/maxDelayMs/jitterFactor/
 *   resetTimeoutMs -- see hardening.mjs).
 * @param {Function} [opts.onLog]
 * @returns {Promise<{
 *   negotiate: (endpoints: object, auth?: object) => Promise<object>,
 *   metrics: import('@johnhenry/browsermesh-core').MetricsRegistry,
 *   failovers: Map<string, import('@johnhenry/browsermesh-core').TransportFailover>,
 *   retries: Map<string, import('@johnhenry/browsermesh-core').RetryWithBackoff>,
 * }>}
 */
export async function createHardenedNegotiator({ negotiator, retryOptions, onLog }) {
  if (!negotiator) {
    throw new Error('createHardenedNegotiator: options.negotiator is required')
  }
  // Lazily imported (an optional peerDependency) -- see the CHANGELOG entry
  // documenting this fix. BREAKING: this function is now async (was sync);
  // its one in-repo caller (mesh-bootstrap.mjs) is updated to match.
  const { RetryWithBackoff, TransportFailover, MetricsRegistry } = await import('@johnhenry/browsermesh-core')
  const log = onLog || (() => {})
  const metrics = new MetricsRegistry()
  const failovers = new Map()
  const retries = new Map()

  function getRetry(key) {
    let retry = retries.get(key)
    if (!retry) {
      retry = new RetryWithBackoff(retryOptions)
      retries.set(key, retry)
    }
    return retry
  }

  function getFailover(key, endpoints, auth) {
    let failover = failovers.get(key)
    if (!failover) {
      failover = new TransportFailover({ negotiator, endpoints, auth, retry: getRetry(key) })
      failovers.set(key, failover)
    }
    return failover
  }

  async function negotiate(endpoints, auth) {
    const key = endpointsKey(endpoints, auth)
    const failover = getFailover(key, endpoints, auth)
    const transportMetrics = metrics.getOrCreate(key)
    const startedAt = Date.now()

    let transport
    try {
      transport = failover.activeTransport
        ? await failover.failover('mesh-hardening:reconnect')
        : await failover.connect()
    } catch (err) {
      transportMetrics.recordError()
      log('mesh-hardening:negotiate-failed', { key, error: err?.message || String(err) })
      throw err
    }

    transportMetrics.recordLatency(Date.now() - startedAt)
    return instrumentTransport(transport, transportMetrics)
  }

  return { negotiate, metrics, failovers, retries }
}
