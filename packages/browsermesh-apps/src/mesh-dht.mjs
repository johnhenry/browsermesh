/**
 * mesh-dht.mjs -- wires `@johnhenry/browsermesh-discovery`'s
 * `DhtDiscoveryStrategy` (dht.mjs) into `createMeshNode()` (Phase D, issue
 * #87: "Unwired: Kademlia DHT discovery").
 *
 * `DhtDiscoveryStrategy` is a real, tested `DiscoveryStrategy` implementation
 * -- but its constructor only takes a bare `sendFn: (targetId, msg) => void`.
 * It has NO transport of its own: something else has to actually deliver
 * that message to `targetId`, and route the reply back into
 * `strategy.dhtNode.handleMessage(fromId, msg)`. dht.mjs's own tests (see
 * `packages/browsermesh-discovery/test/dht.test.mjs`) only ever pass a
 * `sendFn` that pushes into a local array -- there is no in-repo precedent
 * for what a *real* `sendFn` looks like, which is exactly why nothing ever
 * constructed `DhtDiscoveryStrategy` outside its own test file.
 *
 * The cold-start problem this does NOT solve: a Kademlia DHT node needs some
 * way to exchange PING/FIND_NODE/FIND_VALUE/STORE messages with other DHT
 * nodes before a WebRTC connection to any of them exists (that's the whole
 * point of discovery -- you don't have a connection yet). `createMeshNode()`
 * already has exactly one thing that fits: `signalingTransport`, the
 * caller-supplied bidirectional bus used to relay WebRTC offer/answer/ICE
 * traffic between peers *before* their DataChannel exists (see
 * signaling.mjs). This module multiplexes DHT wire traffic onto that same
 * bus rather than inventing a second one.
 *
 * What this buys you: once two or more `createMeshNode({ enableDht: true })`
 * nodes share a `signalingTransport` bus (a `BroadcastChannel`, a
 * `SharedWorker` relay, a real signaling server, or an in-process bus like
 * the test suites use) AND at least one already knows another's `podId`
 * (`dhtBootstrapPeers`), they bootstrap a routing table and can discover
 * each other and any peer transitively reachable through DHT `STORE`
 * replication over that bus.
 *
 * What this does NOT buy you: a way to find that first peer with zero prior
 * knowledge. `DhtDiscoveryStrategy.query()` only ever inspects the *local*
 * `DhtNode`'s own store/routing table (see dht.mjs's `findValue()` /
 * `findNode()`) -- it never issues a network FIND_NODE/FIND_VALUE RPC and
 * waits on the answer, so there is no genuine iterative Kademlia lookup
 * here, only local-store replication seeded by `bootstrap()`. Two nodes with
 * no shared bootstrap peer and no other rendezvous mechanism cannot find
 * each other via DHT alone, exactly like `ManualStrategy` today -- DHT's
 * real advantage over `ManualStrategy` is that discovery propagates
 * transitively once *some* peers share bootstrap knowledge (A+B bootstrapped
 * together, C bootstraps with B alone, C can still learn of A once B
 * replicates A's record to C), not that it solves rendezvous from nothing.
 * A real rendezvous service (well-known bootstrap nodes, a public tracker,
 * DNS seeds, etc.) is infrastructure this repo does not have and is out of
 * scope here; `dhtBootstrapPeers` is the honest, explicit escape hatch for
 * supplying that out-of-band knowledge yourself.
 *
 * No browser-only imports at module level.
 *
 * `@johnhenry/browsermesh-discovery` (an optional peerDependency) is
 * lazily resolved via `createRequire(import.meta.url)` -- Node's stable
 * synchronous `require()` of an ES module (Node >=22.12/23, well within
 * this package's own `engines.node: >=24` floor), not a dynamic `import()`.
 * `createMeshDht()` is synchronous, has a directly-tested synchronous
 * validation-throw contract (`test/mesh-dht.test.mjs`'s
 * `assert.throws(...)`), and returns `{strategy, dhtNode, teardown}`
 * directly to ~11 synchronous call sites in its own test file -- an async
 * `import()` would have broken all of that (see the CHANGELOG entry
 * documenting this fix across the package). `require()` resolves lazily
 * (only when `createMeshDht()` is actually called, after its own
 * validation throws) while staying fully synchronous, so none of that
 * changes.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Default `type` tag for DHT wire messages multiplexed onto a shared transport. */
const DEFAULT_MESSAGE_TYPE = 'dht-relay'

// ---------------------------------------------------------------------------
// shareTransport
// ---------------------------------------------------------------------------

/**
 * Wrap a raw `{send(msg), onMessage(cb), open?, close?}` transport so more
 * than one independent listener can subscribe to it.
 *
 * Most real transports in this repo are single-subscriber: e.g.
 * `signaling.mjs`'s `createBroadcastChannelSignalingTransport()` implements
 * `onMessage(cb) { handler = cb }`, where a second `onMessage()` call
 * silently *replaces* the first rather than adding a second listener. When
 * `createMeshNode({ enableDht: true })` needs to put both
 * `MeshSignalingChannel` (WebRTC signaling) and DHT wire traffic on the same
 * caller-supplied `signalingTransport`, both must go through one shared
 * subscription to the underlying transport, or one silently stops receiving
 * messages depending on construction order.
 *
 * @param {{send: Function, onMessage: Function, open?: Function, close?: Function}} rawTransport
 * @returns {{send: Function, onMessage: Function, open?: Function, close?: Function}}
 *   A transport-shaped object safe for multiple independent `onMessage()`
 *   subscribers. `onMessage()` returns an unsubscribe function.
 */
export function shareTransport(rawTransport) {
  const listeners = new Set()
  let subscribed = false
  const ensureSubscribed = () => {
    if (subscribed) return
    subscribed = true
    rawTransport.onMessage((msg) => {
      for (const cb of [...listeners]) cb(msg)
    })
  }
  return {
    send: (msg) => rawTransport.send(msg),
    onMessage: (cb) => {
      ensureSubscribed()
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    ...(typeof rawTransport.open === 'function' ? { open: () => rawTransport.open() } : {}),
    ...(typeof rawTransport.close === 'function' ? { close: () => rawTransport.close() } : {}),
  }
}

// ---------------------------------------------------------------------------
// createMeshDht
// ---------------------------------------------------------------------------

/**
 * Build a real, wire-connected `DhtDiscoveryStrategy`: constructs the
 * strategy with a `sendFn` that sends over `transport`, and subscribes to
 * `transport` to route matching incoming messages into
 * `strategy.dhtNode.handleMessage()` -- the two halves dht.mjs itself
 * deliberately leaves to the caller (see this file's header).
 *
 * @param {object} opts
 * @param {string} opts.localPodId - This node's pod identifier.
 * @param {{send: Function, onMessage: Function}} opts.transport - Injectable
 *   bidirectional bus reaching other DHT peers by podId -- typically
 *   `createMeshNode()`'s own `signalingTransport` (wrapped via
 *   `shareTransport()` so WebRTC signaling keeps working on the same bus),
 *   or a dedicated bus if you have one.
 * @param {Array<string|{podId: string}>} [opts.bootstrapPeers=[]] - Already-known
 *   peer podIds (or `{podId}` records) to seed the DHT routing table with.
 *   Required for this node to discover anyone at all -- see this file's
 *   header for why DHT does not solve first-contact rendezvous from nothing.
 * @param {number} [opts.k] - Kademlia bucket size, forwarded to
 *   `DhtDiscoveryStrategy` (defaults to 20 there).
 * @param {string} [opts.messageType='dht-relay'] - `type` tag used to
 *   distinguish DHT wire messages from other traffic sharing `transport`
 *   (e.g. `signaling.mjs`'s `'webrtc-offer'|'webrtc-answer'|'webrtc-ice'`).
 * @param {Function} [opts.onLog]
 * @returns {{strategy: DhtDiscoveryStrategy, dhtNode: import('@johnhenry/browsermesh-discovery').DhtNode, teardown: () => void}}
 */
export function createMeshDht({
  localPodId,
  transport,
  bootstrapPeers = [],
  k,
  messageType = DEFAULT_MESSAGE_TYPE,
  onLog = () => {},
}) {
  if (!localPodId || typeof localPodId !== 'string') {
    throw new Error('createMeshDht: options.localPodId is required and must be a non-empty string')
  }
  if (!transport || typeof transport.send !== 'function' || typeof transport.onMessage !== 'function') {
    throw new Error('createMeshDht: options.transport is required and must implement send(msg)/onMessage(cb)')
  }

  // Lazy, synchronous (see module doc comment) -- only reached once
  // validation above has already passed.
  const { DhtDiscoveryStrategy } = require('@johnhenry/browsermesh-discovery')

  const sendFn = (targetId, msg) => {
    transport.send({ type: messageType, from: localPodId, to: targetId, payload: msg })
  }

  const strategy = new DhtDiscoveryStrategy({
    localId: localPodId,
    sendFn,
    k,
    bootstrapContacts: bootstrapPeers.map((p) => (typeof p === 'string' ? { podId: p } : p)),
  })

  const unsubscribe = transport.onMessage((raw) => {
    if (!raw || typeof raw !== 'object') return
    if (raw.type !== messageType) return
    if (raw.to !== localPodId) return // not addressed to us
    if (raw.from === localPodId) return // ignore our own broadcast echo
    try {
      strategy.dhtNode.handleMessage(raw.from, raw.payload)
    } catch (err) {
      onLog('mesh-dht:handle-message-failed', {
        from: raw.from,
        error: err?.message || String(err),
      })
    }
  })

  return {
    strategy,
    dhtNode: strategy.dhtNode,
    teardown: () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    },
  }
}
