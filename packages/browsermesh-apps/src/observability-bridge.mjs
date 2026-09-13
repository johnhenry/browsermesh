/**
 * observability-bridge.mjs -- Phase 2 of the mesh-KV-and-observability plan
 * (`mesh-kv-and-observability.md`): the adapter that finally gives
 * `visualizations.mjs` (903 lines, real, tested, previously dormant -- see
 * that file's own module doc comment) a genuine data source, by subscribing
 * to Phase 1's `ctx.emit()` observability convention (`mesh-service.mjs`)
 * and a real `PeerNode`'s own connect/disconnect events (`peer-node.mjs`).
 *
 * This file is intentionally NOT a rewrite of `visualizations.mjs` (per the
 * plan's own "Design decisions" section: "the observability bridge is new
 * code, not a `visualizations.mjs` rewrite") -- `TopologySnapshot`,
 * `TrustHeatmap`, and `VisualizationExporter` are used exactly as they
 * already exist. It is also NOT a `MeshService` itself: it consumes events
 * from already-attached services and from a `PeerNode`, it doesn't attach
 * anything of its own to the mesh for messaging purposes.
 *
 * ---------------------------------------------------------------------------
 * TWO INPUT STREAMS, kept deliberately separate (mirroring the plan's own
 * framing: "peer connect/disconnect -> TopologySnapshot, a couple of the
 * most illustrative service events -> TrustHeatmap/edge weight"):
 *
 *   1. `PeerNode`'s own `'peer:connect'`/`'peer:disconnect'` events
 *      (`peer-node.mjs`'s `on()`/`off()`, backed by `PeerRegistry`'s
 *      `onPeerConnect()`/`onPeerDisconnect()`) -- these are TRANSPORT-LEVEL
 *      session events, entirely independent of which `MeshService`s (if
 *      any) happen to be attached. `createObservabilityBridge()` always
 *      wires these the moment it's constructed (no opt-in needed): every
 *      `PeerNode` has them, so there is nothing to scope here.
 *
 *   2. Per-service `attachService()` handle events (`handle.on()`), opted
 *      into explicitly per handle via `bridge.observe(handle)` -- the
 *      caller decides which attached services' events this bridge should
 *      see, this file never reaches into a node's internals to discover
 *      services on its own (matching the plan's "the caller of your
 *      adapter needs to pass in the handles it wants observed, don't
 *      hardcode which services" instruction... with one caveat: WHICH of a
 *      given service's OWN events get wired, once its handle is passed to
 *      `observe()`, is fixed by this file -- see "Curated events" below).
 *
 * ---------------------------------------------------------------------------
 * TopologySnapshot HAS NO `addNode()`/`addEdge()`/`removeNode()` METHODS
 * (only `TrustGraphLayout` does) -- checked directly against
 * `visualizations.mjs` before writing this file. `TopologySnapshot.nodes`/
 * `.links` are plain, non-frozen, publicly-assigned arrays (not private
 * fields), so this bridge mutates them directly via small
 * upsert/remove helpers (`upsertNode()`/`upsertLink()`/`removeLink()`
 * below) that reproduce the "add if missing, patch if present" semantics
 * the task description asked for, using the surface `TopologySnapshot`
 * actually exposes rather than inventing methods on that class (which
 * would violate the plan's "not a `visualizations.mjs` rewrite" decision).
 *
 * DISCONNECT REMOVES THE EDGE, NOT THE NODE (a deliberate reading of
 * "removal", stated explicitly): when a peer disconnects, the LINK between
 * the local node and that peer is removed (it genuinely no longer exists),
 * but the peer's NODE is kept, with `status` updated to `'disconnected'`.
 * Deleting the node entirely on every disconnect would (a) orphan any
 * `TrustHeatmap` entry already recorded for that peer via a grant-log event
 * (trust from a grant survives a transport blip -- that's the whole point
 * of Phase D's replicated GrantLog outliving any one session), and (b)
 * make `TopologyDiff.compute()` across a disconnect/reconnect blip report a
 * node removal+re-add instead of a status change, which is a strictly
 * less useful signal for a dashboard. A caller that genuinely wants
 * fully-gone peers pruned from the topology can do so itself against
 * `bridge.snapshot.nodes` -- this file does not make that call for them.
 *
 * ---------------------------------------------------------------------------
 * CURATED SERVICE EVENTS -- per the plan's explicit instruction ("don't try
 * to wire every single event from every service; pick a few that tell a
 * real story... Document exactly which events you chose to wire and why,
 * and which you deliberately left out"):
 *
 * `grant-log:*` (any handle whose `.name` starts with `'grant-log:'`):
 *   - WIRED: `grant-log:grant-applied` -- bumps `TrustHeatmap`'s
 *     `(localPodId, pubKey)` trust value up by `TRUST_STEP` per newly
 *     effective scope (capped at 1). This is the plan's own named example
 *     ("grant-log:grant-applied feeding TrustHeatmap's trust value for
 *     that peer").
 *   - WIRED: `grant-log:revoke-applied` -- the natural complement, moves
 *     trust back down by the same step per scope that stopped being
 *     effective (capped at 0). Left out would make the heatmap only ever
 *     climb, never reflecting an actual revoke -- a materially misleading
 *     "trust" signal for a dashboard to show.
 *   - LEFT OUT: `grant-log:admin-changed`. It fires ALONGSIDE
 *     `grant-applied`/`revoke-applied` specifically when the changed scope
 *     is the admin scope (see `grant-log.mjs`'s own doc comment) -- wiring
 *     it too would double-count the exact same transition into the trust
 *     heatmap a second time. A future revision that wants to visually
 *     distinguish "admin" trust from "ordinary capability" trust should add
 *     a SEPARATE heatmap/series for it, not fold it into this one.
 *
 * `chunk-replication:*` (any handle whose `.name` starts with
 * `'chunk-replication:'`):
 *   - WIRED: `chunk-replication:chunk-replicated` -- for each peer in
 *     `replicatedTo`, upserts an edge from the local node to that peer and
 *     increments an `activity` counter on it (a simple, monotonic "how much
 *     replication traffic has flowed on this edge" indicator -- the plan's
 *     own named example, "chunk-replication:chunk-replicated updating an
 *     edge weight/activity indicator").
 *   - LEFT OUT: `chunk-replication:read-repair` (a lazy-pull success --
 *     topologically it's the same "bytes moved between these two peers"
 *     story as `chunk-replicated`, and folding both into the same
 *     `activity` counter would conflate eager-push health with read-repair
 *     frequency, two different operational signals; a future revision
 *     wanting BOTH should track them as separate edge fields, not overload
 *     one), `chunk-replication:push-rejected` and
 *     `chunk-replication:fetch-exhausted` (both failure/security-relevant
 *     events, not topology state -- nothing about the mesh's shape changed
 *     because a push was rejected or a fetch was exhausted; these belong on
 *     a security/error dashboard, not a topology map).
 *
 * `mesh-websocket` (a handle whose `.name === 'mesh-websocket'`, i.e. only
 * the ACCEPTING side's `createMeshWebSocketService()` handle -- see that
 * file's own doc comment: only that side has a `ctx` to emit through at
 * all):
 *   - WIRED: `mesh-websocket:connection-opened` -- upserts a node + edge for
 *     the connecting peer. `mesh-websocket:connection-closed` -- removes
 *     that edge (mirrors the disconnect handling above: the connection
 *     genuinely stopped existing). Together these are the plan's own named
 *     example ("mesh-websocket:connection-opened/connection-closed
 *     updating TopologySnapshot edges").
 *   - LEFT OUT: `mesh-websocket:connection-rejected` -- no session was ever
 *     established, so there is no edge to represent; this is a security/
 *     policy event (an `onConnection` hook said no), same reasoning as the
 *     chunk-replication failure events above.
 *
 * `mesh-kv:` (any handle whose `.name` starts with `'mesh-kv:'`, i.e.
 * `createMeshKvService()`'s own low-level handle -- see `mesh-kv.mjs`'s
 * module doc comment for the full event vocabulary. Phase 3 shipped after
 * this file, so this bucket is a Phase 4 addition to the same curation
 * exercise, not part of the original Phase 2 pass):
 *   - WIRED: `mesh-kv:watching`/`mesh-kv:unwatching` -- the store-level
 *     analogue of `mesh-websocket`'s open/close pair above: `watching`
 *     upserts a node + edge FROM the local node TO the watched peer
 *     (`status: 'watching'`, this store's `storeId` recorded on the edge);
 *     `unwatching` removes that edge. A `MeshKv.grant()` call always
 *     triggers a `watch()` immediately after applying the grant (see
 *     `mesh-kv.mjs`), so in practice this is the topology-level trace of
 *     "who currently has live access to this store."
 *   - WIRED: `mesh-kv:entry-set`/`mesh-kv:entry-deleted` -- only when
 *     `data.from !== ` this bridge's own `localId()` (i.e. only for an
 *     ACCEPTED REMOTE merge, not a local write): upserts an edge FROM the
 *     writing peer (`from`) TO the local node and increments its `activity`
 *     counter by 1, the same "how much traffic flowed on this edge"
 *     semantic `chunk-replication:chunk-replicated` uses above. A LOCAL
 *     `set()`/`delete()` (`from === localId()`) is deliberately NOT wired to
 *     an edge: the event payload carries no counterpart peer id for a local
 *     write (it could be broadcast to zero, one, or many watchers), so there
 *     is no single edge a local write could unambiguously update -- a
 *     caller that wants to see the LOCAL side of that same activity can read
 *     it directly off `mesh-kv:entry-set`/`entry-deleted` itself (this
 *     bridge does not need to be the only consumer of a service's events).
 *   - LEFT OUT: `mesh-kv:write-rejected` -- a security-relevant rejection,
 *     not a topology-state change (nothing about the mesh's shape or an
 *     edge's activity actually changed because a write was refused), same
 *     reasoning as `chunk-replication:push-rejected`/
 *     `mesh-websocket:connection-rejected` above.
 *
 * A handle whose `.name` doesn't match any of the four patterns above is
 * accepted by `observe()` without throwing (a caller passing in every
 * attached service's handle indiscriminately shouldn't have to filter
 * first) but nothing is wired for it -- `onLog` (if supplied) is told via
 * `observability-bridge:unrecognized-service`, matching this family's
 * established convention of a non-fatal, discoverable no-op rather than a
 * silent one or a thrown error.
 *
 * ---------------------------------------------------------------------------
 * OUTPUT: reuses `VisualizationExporter` AS-IS (no reimplementation) --
 * `bridge.exportTopology(layoutEngine?, layoutType?)` /
 * `bridge.exportHeatmap()` call straight through to
 * `VisualizationExporter#exportTopology()`/`#exportHeatmap()` against the
 * `TopologySnapshot`/`TrustHeatmap` instances this bridge maintains
 * (either caller-supplied via `opts.snapshot`/`opts.heatmap`, or created
 * internally if omitted -- letting a caller share one `TopologySnapshot`
 * across multiple bridges/nodes if it wants a single node-wide view, per
 * `mesh-service.mjs`'s own "a later composition layer... does that fan-in"
 * note).
 *
 * No browser-only imports at module level.
 */

import { TopologySnapshot, TrustHeatmap, VisualizationExporter } from './visualizations.mjs'

/** How much one grant-applied/revoke-applied scope changes a heatmap trust value by. Not a tuned constant -- a simple, demonstrable default; a caller wanting different trust semantics should post-process `bridge.heatmap` itself. */
const TRUST_STEP = 0.2

/** @param {number} n @returns {number} */
function clamp01(n) {
  return Math.max(0, Math.min(1, n))
}

// ---------------------------------------------------------------------------
// TopologySnapshot mutation helpers -- see module doc comment for why these
// exist (TopologySnapshot itself has no addNode()/addEdge()/removeNode()).
// ---------------------------------------------------------------------------

/** @param {TopologySnapshot} snapshot @param {string} id @param {object} patch */
function upsertNode(snapshot, id, patch) {
  if (!id) return
  const idx = snapshot.nodes.findIndex((n) => n.id === id)
  if (idx === -1) {
    snapshot.nodes.push({ id, ...patch })
  } else {
    snapshot.nodes[idx] = { ...snapshot.nodes[idx], ...patch }
  }
}

/** @param {TopologySnapshot} snapshot @param {string} from @param {string} to @returns {number} */
function findLinkIndex(snapshot, from, to) {
  return snapshot.links.findIndex((l) => l.from === from && l.to === to)
}

/** @param {TopologySnapshot} snapshot @param {string} from @param {string} to @param {object} patch */
function upsertLink(snapshot, from, to, patch) {
  if (!from || !to) return
  const idx = findLinkIndex(snapshot, from, to)
  if (idx === -1) {
    snapshot.links.push({ from, to, ...patch })
  } else {
    snapshot.links[idx] = { ...snapshot.links[idx], ...patch }
  }
}

/** @param {TopologySnapshot} snapshot @param {string} from @param {string} to */
function removeLink(snapshot, from, to) {
  const idx = findLinkIndex(snapshot, from, to)
  if (idx !== -1) snapshot.links.splice(idx, 1)
}

// ---------------------------------------------------------------------------
// createObservabilityBridge
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {import('./peer-node.mjs').PeerNode} opts.peerNode - A real
 *   `PeerNode` (must provide `.podId`, `.on()`, `.off()` -- the
 *   `'peer:connect'`/`'peer:disconnect'` events this bridge always wires).
 * @param {TopologySnapshot} [opts.snapshot] - Reused as-is if supplied
 *   (lets multiple bridges/nodes share one node-wide snapshot); a fresh one
 *   is created otherwise.
 * @param {TrustHeatmap} [opts.heatmap] - Same sharing story as `snapshot`.
 * @param {VisualizationExporter} [opts.exporter] - Same sharing story;
 *   `VisualizationExporter` is stateless, so a fresh one is cheap either way.
 * @param {Function} [opts.onLog] - Free-form debug logging, matching every
 *   other file in this family's `onLog` convention (NOT the `ctx.emit()`
 *   convention this bridge is itself consuming -- this bridge has no `ctx`
 *   of its own, it is not a `MeshService`).
 * @returns {{
 *   observe: (handle: {name: string, on: Function}) => (() => void),
 *   snapshot: TopologySnapshot,
 *   heatmap: TrustHeatmap,
 *   exportTopology: (layoutEngine?: import('./visualizations.mjs').TopologyLayout, layoutType?: string) => object,
 *   exportHeatmap: () => object,
 *   teardown: () => void,
 * }}
 */
export function createObservabilityBridge({ peerNode, snapshot, heatmap, exporter, onLog } = {}) {
  if (!peerNode || typeof peerNode.on !== 'function' || typeof peerNode.off !== 'function') {
    throw new Error('createObservabilityBridge: peerNode is required and must provide on()/off() (a real PeerNode)')
  }

  const topology = snapshot instanceof TopologySnapshot ? snapshot : new TopologySnapshot({ id: `observability:${peerNode.podId || 'local'}` })
  const trust = heatmap instanceof TrustHeatmap ? heatmap : new TrustHeatmap()
  const exp = exporter instanceof VisualizationExporter ? exporter : new VisualizationExporter()
  const log = typeof onLog === 'function' ? onLog : () => {}

  /** @returns {string} */
  function localId() {
    return peerNode.podId || 'local'
  }

  upsertNode(topology, localId(), { label: localId(), type: 'self', status: 'running' })

  // -------------------------------------------------------------------
  // 1. PeerNode's own connect/disconnect -> TopologySnapshot
  // -------------------------------------------------------------------

  /** @param {{fingerprint?: string, label?: string, status?: string, transport?: string}} peer */
  function handlePeerConnect(peer) {
    const id = peer?.fingerprint
    if (!id) return
    upsertNode(topology, localId(), { label: localId(), type: 'self', status: 'running' })
    upsertNode(topology, id, { label: peer.label || id, type: 'peer', status: peer.status || 'connected' })
    upsertLink(topology, localId(), id, { transport: peer.transport || undefined, status: 'connected' })
    log('observability-bridge:peer-connected', { id })
  }

  /** @param {{fingerprint?: string}} peer */
  function handlePeerDisconnect(peer) {
    const id = peer?.fingerprint
    if (!id) return
    upsertNode(topology, id, { status: 'disconnected' })
    removeLink(topology, localId(), id)
    log('observability-bridge:peer-disconnected', { id })
  }

  peerNode.on('peer:connect', handlePeerConnect)
  peerNode.on('peer:disconnect', handlePeerDisconnect)

  // -------------------------------------------------------------------
  // 2. Per-service handle.on() -> TrustHeatmap / TopologySnapshot
  //    See module doc comment's "Curated service events" section for the
  //    exact vocabulary wired per service and why.
  // -------------------------------------------------------------------

  const serviceUnsubscribes = []

  /** @param {{on: Function}} handle */
  function observeGrantLog(handle) {
    serviceUnsubscribes.push(handle.on('grant-log:grant-applied', (data) => {
      const { pubKey, added } = data || {}
      if (!pubKey || !Array.isArray(added) || added.length === 0) return
      const current = trust.getTrust(localId(), pubKey)
      trust.setTrust(localId(), pubKey, clamp01(current + TRUST_STEP * added.length))
      upsertNode(topology, pubKey, { label: pubKey, type: 'peer' })
      log('observability-bridge:trust-increased', { pubKey, added })
    }))
    serviceUnsubscribes.push(handle.on('grant-log:revoke-applied', (data) => {
      const { pubKey, removed } = data || {}
      if (!pubKey || !Array.isArray(removed) || removed.length === 0) return
      const current = trust.getTrust(localId(), pubKey)
      trust.setTrust(localId(), pubKey, clamp01(current - TRUST_STEP * removed.length))
      log('observability-bridge:trust-decreased', { pubKey, removed })
    }))
  }

  /** @param {{on: Function}} handle */
  function observeChunkReplication(handle) {
    serviceUnsubscribes.push(handle.on('chunk-replication:chunk-replicated', (data) => {
      const { cids, replicatedTo } = data || {}
      if (!Array.isArray(replicatedTo)) return
      for (const peerId of replicatedTo) {
        upsertNode(topology, peerId, { label: peerId, type: 'peer' })
        const idx = findLinkIndex(topology, localId(), peerId)
        const activity = (idx !== -1 ? topology.links[idx].activity || 0 : 0) + 1
        upsertLink(topology, localId(), peerId, { status: 'connected', activity, lastReplicatedCids: cids })
      }
      log('observability-bridge:chunk-replicated', { replicatedTo, cids })
    }))
  }

  /** @param {{on: Function}} handle */
  function observeMeshWebsocket(handle) {
    serviceUnsubscribes.push(handle.on('mesh-websocket:connection-opened', (data) => {
      const { from, path } = data || {}
      if (!from) return
      upsertNode(topology, from, { label: from, type: 'peer' })
      upsertLink(topology, localId(), from, { status: 'open', transport: 'mesh-websocket', path })
      log('observability-bridge:ws-opened', { from, path })
    }))
    serviceUnsubscribes.push(handle.on('mesh-websocket:connection-closed', (data) => {
      const { from } = data || {}
      if (!from) return
      removeLink(topology, localId(), from)
      log('observability-bridge:ws-closed', { from })
    }))
  }

  /** @param {{on: Function}} handle */
  function observeMeshKv(handle) {
    serviceUnsubscribes.push(handle.on('mesh-kv:watching', (data) => {
      const { pubKey, storeId } = data || {}
      if (!pubKey) return
      upsertNode(topology, pubKey, { label: pubKey, type: 'peer' })
      upsertLink(topology, localId(), pubKey, { status: 'watching', storeId })
      log('observability-bridge:mesh-kv-watching', { pubKey, storeId })
    }))
    serviceUnsubscribes.push(handle.on('mesh-kv:unwatching', (data) => {
      const { pubKey } = data || {}
      if (!pubKey) return
      removeLink(topology, localId(), pubKey)
      log('observability-bridge:mesh-kv-unwatching', { pubKey })
    }))

    /** @param {boolean} tombstone @param {object} data */
    function handleEntryChange(tombstone, data) {
      const { from, key, storeId } = data || {}
      // Only an accepted REMOTE merge has a meaningful counterpart edge --
      // see module doc comment's "mesh-kv:" section for why a local write
      // is deliberately not wired to any single edge.
      if (!from || from === localId()) return
      upsertNode(topology, from, { label: from, type: 'peer' })
      const idx = findLinkIndex(topology, from, localId())
      const activity = (idx !== -1 ? topology.links[idx].activity || 0 : 0) + 1
      upsertLink(topology, from, localId(), { status: 'connected', activity, storeId, lastKey: key })
      log('observability-bridge:mesh-kv-activity', { from, key, storeId, tombstone })
    }
    serviceUnsubscribes.push(handle.on('mesh-kv:entry-set', (data) => handleEntryChange(false, data)))
    serviceUnsubscribes.push(handle.on('mesh-kv:entry-deleted', (data) => handleEntryChange(true, data)))
  }

  const WIRERS = [
    { test: (name) => name.startsWith('grant-log:'), wire: observeGrantLog },
    { test: (name) => name.startsWith('chunk-replication:'), wire: observeChunkReplication },
    { test: (name) => name === 'mesh-websocket', wire: observeMeshWebsocket },
    { test: (name) => name.startsWith('mesh-kv:'), wire: observeMeshKv },
  ]

  /**
   * Opt this bridge into one attached service's curated events. The caller
   * decides WHICH handles to pass (this file never enumerates a node's
   * services on its own) -- see module doc comment's "Curated service
   * events" section for exactly what gets wired per recognized `.name`.
   * @param {{name: string, on: (event: string, cb: Function) => (() => void)}} handle
   *   An `attachService()`-returned handle (`mesh-service.mjs`).
   * @returns {() => void} No-op (subscriptions are torn down as a group via
   *   this bridge's own `teardown()`, not individually -- matches
   *   `attachService()`'s own handle, whose `teardown()` similarly stops
   *   ALL of that service's event delivery at once, not per-subscriber).
   */
  function observe(handle) {
    if (!handle || typeof handle.on !== 'function' || typeof handle.name !== 'string') {
      throw new Error('createObservabilityBridge: observe(handle) requires an attachService() handle ({name, on, ...})')
    }
    const wirer = WIRERS.find((w) => w.test(handle.name))
    if (!wirer) {
      log('observability-bridge:unrecognized-service', { name: handle.name })
      return () => {}
    }
    wirer.wire(handle)
    return () => {}
  }

  return {
    observe,
    get snapshot() { return topology },
    get heatmap() { return trust },

    /**
     * @param {import('./visualizations.mjs').TopologyLayout} [layoutEngine]
     * @param {string} [layoutType='circular']
     * @returns {object} `VisualizationExporter#exportTopology()`'s output, unmodified.
     */
    exportTopology(layoutEngine, layoutType) {
      return exp.exportTopology(topology, layoutEngine, layoutType)
    },

    /** @returns {object} `VisualizationExporter#exportHeatmap()`'s output, unmodified. */
    exportHeatmap() {
      return exp.exportHeatmap(trust)
    },

    /** Stops all further updates from both the `PeerNode` and every `observe()`d service handle. Does not clear already-recorded `snapshot`/`heatmap` state. */
    teardown() {
      peerNode.off('peer:connect', handlePeerConnect)
      peerNode.off('peer:disconnect', handlePeerDisconnect)
      for (const unsubscribe of serviceUnsubscribes) {
        if (typeof unsubscribe === 'function') unsubscribe()
      }
      serviceUnsubscribes.length = 0
    },
  }
}
