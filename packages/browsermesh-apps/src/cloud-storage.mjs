/**
 * cloud-storage.mjs -- Phase H of the mesh-native-services plan
 * ("CloudStorage: S3-like object storage"): the actual developer-facing
 * class from the plan's Context section --
 *
 *   import { CloudStorage as s3 } from '@johnhenry/browsermesh-apps'
 *   const store = new s3({ bucket: 'my-bucket', node: peerNode, network })
 *   await store.put('key', data)
 *
 * This file composes Phases B/D/E/F/G into one ergonomic entry point so a
 * caller never needs to know `GrantLog`, `key-distribution.mjs`,
 * `manifest-sync.mjs`, or `chunk-replication.mjs` exist:
 *
 *   - `CloudStorageBackend` (Phase B) -- the local, durable, encrypted-at-
 *     rest single-peer object store this class talks to over its own
 *     private JSON-command socket (`fs-service-backend.mjs`'s convention,
 *     see that file's module doc comment).
 *   - `createKeyDistributionService()` (Phase E) + `createGrantLogService()`
 *     (Phase D), attached in that exact order with `onGrantChange`/`onReady`
 *     wired between them -- this is `grant-log.mjs`'s own documented
 *     composition order (see that file's "Composition with
 *     createGrantLogService()" section), reused verbatim here rather than
 *     re-derived.
 *   - `createManifestSyncService()` (Phase F) -- cross-peer manifest CRDT
 *     sync, ACL-gated against the GrantLog's replayed state.
 *   - `createChunkReplicationService()` (Phase G) -- eager push-to-replica
 *     and lazy pull/read-repair for the actual ciphertext chunk bytes.
 *
 * All four are attached via `attachService()` (`mesh-service.mjs`, Phase C)
 * with NO `network` required -- none of D/E/F/G declare `createBackend`, so
 * `attachService()` never needs one for them (see `mesh-service.mjs`'s own
 * doc comment: `createBackend` is optional per-descriptor, and
 * `attachService()` only throws for a descriptor that both declares it AND
 * is attached with no network).
 *
 * ---------------------------------------------------------------------------
 * DESIGN DECISIONS / GAPS THE PLAN LEFT OPEN, RESOLVED HERE (read before
 * changing this file's behavior):
 *
 * 1. **`network` is OPTIONAL**, and this is a real simplification versus
 *    Phase B's original framing, not an oversight. Before this class
 *    existed, a caller needed `network.addBackend()` plus a netway
 *    `Backend`-shaped socket protocol just to talk to a bucket at all --
 *    that machinery is still real and still useful (e.g. another local
 *    process, or a debugging tool, connecting via
 *    `network.connect('s3-<bucket>://...')` using the raw JSON-command
 *    protocol), but `CloudStorage` itself never needs it: it opens its OWN
 *    private socket directly against `CloudStorageBackend.connect()`
 *    in-process (see `#sendCommand()`) to implement `put`/`get`/`delete`/
 *    `list`. `network`, when supplied, is used ONLY to additionally
 *    register the backend on it (under `opts.backendScheme`, default
 *    `s3-<bucket>`) for that legacy/advanced raw-socket use case -- most
 *    callers can omit it entirely.
 *
 * 2. **`get()`'s "not found yet" behavior**: a fully decentralized store has
 *    no server to ask "does this key exist" -- a key that was never written
 *    ANYWHERE and a key that was written by another peer but whose manifest
 *    entry has not yet propagated to THIS peer (Phase F's CRDT sync, an
 *    asynchronous background process) are, from this peer's own local
 *    vantage point, briefly indistinguishable. Rather than surface a
 *    separate "pending" state a caller would have to poll (and rather than
 *    hang forever waiting for a sync that might never come, e.g. for a
 *    genuinely nonexistent key), `get()` does a bounded wait
 *    (`manifestWaitMs`, default `DEFAULT_MANIFEST_WAIT_MS` = 3000ms,
 *    overridable per-constructor or per-call) polling the LOCAL manifest
 *    snapshot for the key before giving up. If the key never appears in
 *    time, `get()` throws `CloudStorageNotFoundError` -- the SAME error
 *    class plain absence uses, with `.reason` set to `'not-found'`
 *    (never appeared) or `'deleted'` (found, but tombstoned) for callers
 *    who want to distinguish further. This mirrors real S3's own external
 *    behavior (a 404 either way) while giving ordinary replication lag a
 *    real chance to resolve before concluding "not found" -- documented
 *    here as a deliberate collapsing of two cases into one bounded wait,
 *    not an oversight.
 *
 * 3. **`becomeAdmin()` also self-grants `read`/`write`/`delete`/`list`**,
 *    not just the `admin` scope `GrantLog.bootstrapAdmin()` itself grants.
 *    This is a real, deliberate gap-fill: `grant-log.mjs` treats "who can
 *    grant/revoke" (the `admin` scope, checked by `#assertCanAdminister()`)
 *    and "who can actually use this resource" (every other scope) as
 *    entirely separate grants by design (see that file's module doc
 *    comment) -- bootstrapping admin authority does NOT implicitly grant
 *    the bootstrapper read/write access to their own bucket. Since a
 *    bucket's creator obviously needs to use the bucket they just created,
 *    `becomeAdmin()` performs both steps. Only call this when this instance
 *    is genuinely creating a brand-new bucket (see `GrantLog.bootstrapAdmin()`'s
 *    own doc comment for what happens if two peers race to create the same
 *    bucket id -- the same "earliest write wins" exposure the plan already
 *    accepts for `LWWMap` and the GrantLog's own admin-bootstrap record).
 *
 * 4. **`grant()`/`revoke()` also drive manifest visibility and immediate
 *    propagation**, not just the GrantLog mutation the plan's brief names
 *    literally. Two real family-established facts make this necessary:
 *    neither `GrantLog` nor `manifest-sync.mjs`'s `MeshSyncEngine` binding
 *    auto-broadcasts on a local mutation (see `grant-log.test.mjs`'s and
 *    `manifest-sync.test.mjs`'s own established convention of an explicit
 *    `syncWith()`/`watch()` call after every mutation) -- a caller of this
 *    ergonomic class should not need to know that. So `grant()`:
 *      (a) mutates the local `GrantLog` (`grantLogApi.grant()`),
 *      (b) immediately `syncWith(pubKey)`s the FULL current grant log to
 *          the newly-granted peer (so they also learn about every
 *          PRE-EXISTING grant, including this bucket's admin's own
 *          self-grant from step 3 above -- required for the recipient's
 *          OWN registry to ever accept the admin's writes/pushes; see
 *          `manifest-sync.mjs`'s and `chunk-replication.mjs`'s ACL gates,
 *          both of which check the WRITER's grants on the RECEIVING peer's
 *          own registry),
 *      (c) starts watching the peer for future manifest broadcasts
 *          (`manifestSyncApi.watch()`), and
 *      (d) immediately syncs the CURRENT manifest snapshot to them too, so
 *          pre-existing keys are visible immediately rather than only
 *          becoming visible on the NEXT write.
 *    `revoke()` mirrors this for the negative case (`unwatch()` after the
 *    revoke record propagates) -- though note this is a bandwidth/hygiene
 *    cleanup, not itself a security boundary: the actual content-access
 *    security boundary is `chunk-replication.mjs`'s own per-request
 *    `checkAccess()` gate on `read`/`write`, independent of whether a
 *    manifest broadcast is still being sent.
 *
 * 5. **`designateReplica(pubKey)`** is simply `grant(pubKey, 'replica')` --
 *    `replica` is not a distinct mechanism in `grant-log.mjs` (see that
 *    file's "Replica designation" section: it is implemented as a sixth
 *    ordinary action-scope, `s3:<bucket>:replica`, granted/revoked exactly
 *    like `read`/`write`/etc.), so this method is a named convenience, not
 *    new plumbing.
 *
 * 6. **`replicationFactor` is advisory only, never automatic peer
 *    selection.** The plan's own "User decisions... not open for
 *    re-litigation" section is explicit: replica peers are admin-designated,
 *    never automatically chosen. There is no "pick N replicas from the
 *    network" mechanism anywhere in Phases D-G for this class to drive, and
 *    inventing one here would contradict that decision. `replicationFactor`
 *    is accepted and exposed (`get replicationFactor()`) purely so calling
 *    code / tooling can compare it against `replicaPeers.length` itself;
 *    this class only logs (via `onLog`) if they don't match, and takes no
 *    other action.
 *
 * 7. **What "node" needs to be**: the plan's sketch shows `node: peerNode`,
 *    a "booted PeerNode". This class only ever touches `node.podId`,
 *    `node.wallet` (duck-typed: `sign()`/`verify()`/`getPublicKeyBytes()`,
 *    required transitively by Phases D/E), `node.registry` (`PeerRegistry`,
 *    for `checkAccess()`), `node.sendTo()`, and `node.onIncomingData()` --
 *    exactly `mesh-service.mjs`'s own `createServiceContext()` needs, and
 *    exactly what every Phase C-G unit test's own minimal duck-typed node
 *    fixture already provides instead of a full, WebRTC-connected
 *    `PeerNode`. A real `PeerNode` (from `createMeshNode()`) satisfies this
 *    surface too; this class does not care which.
 *
 * ---------------------------------------------------------------------------
 * KNOWN LIMITATION -- an unauthorized peer's `put()`: because `put()`'s
 * local write can never fail (Phase G's durability contract: the local
 * write is already durable before any replication is attempted), an
 * unauthorized peer's OWN `CloudStorage` instance for the SAME bucket name
 * always resolves `put()` successfully (`{stored: true, durability:
 * 'local-only', replicatedTo: []}`) against its OWN, disconnected local
 * copy -- there is no central arbiter anywhere in this design that could
 * reject it up front. This is architecturally correct, not a bug: that
 * write is never accepted by any OTHER peer's manifest (`manifest-sync.mjs`'s
 * ACL gate rejects it before merge, the same property `manifest-sync.test.mjs`
 * already proves), so it never becomes visible to any authorized reader --
 * "fails cleanly" here means "never corrupts or leaks into the real,
 * shared bucket", not "the promise rejects". `get()`, by contrast, DOES
 * reject cleanly for an unauthorized peer, via the bounded-wait
 * `CloudStorageNotFoundError` above (their local manifest never receives
 * the real writer's entries in the first place, since nobody's
 * `manifest-sync` service ever `watch()`es an unauthorized peer).
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`/`on()`/`onEvent()`, Phase 1 of the
 * mesh-KV-and-observability plan -- see `mesh-service.mjs`'s module doc
 * comment for the full convention this follows). `CloudStorage` is NOT a
 * `MeshService` descriptor itself -- it calls `attachService()` internally
 * four times (D/E/F/G above) and each of THOSE handles already exposes its
 * own low-level `ctx.emit()` vocabulary (see each service's own module doc
 * comment), but `CloudStorage` has no `ctx` of its OWN to emit through.
 * Rather than leave this class out of the convention, or force a caller to
 * separately subscribe to all four internal handles just to observe "this
 * bucket had a put", this class builds its own bus via `mesh-service.mjs`'s
 * exported `createEventBus()` (the exact same `{emit, on, onEvent, closeAll}`
 * shape `attachService()`'s handle uses) and exposes `on(event, callback)`/
 * `onEvent(callback)` methods matching that same handle shape, so a caller
 * that already knows how to subscribe to one `attachService()` handle knows
 * how to subscribe to a `CloudStorage` instance too. Its own vocabulary is
 * deliberately HIGHER-LEVEL than the internal services' wire-protocol
 * events -- application-meaningful transitions a dashboard actually wants
 * ("this bucket had a write", not "chunk X was pushed to peer Y"):
 *
 *   - `cloud-storage:put-completed` `{bucket, key, size, durability}`
 *   - `cloud-storage:get-completed` `{bucket, key}`
 *   - `cloud-storage:delete-completed` `{bucket, key}`
 *   - `cloud-storage:admin-bootstrapped` `{bucket}` -- `becomeAdmin()` finished.
 *   - `cloud-storage:grant-issued` `{bucket, pubKey, scopes}` -- `grant()` finished.
 *
 * `close()` calls the bus's own `closeAll()`, stopping further delivery, the
 * same as `attachService()`'s handle does on `teardown()`.
 *
 * No browser-only imports at module level.
 */

import { attachService, createEventBus } from './mesh-service.mjs'
import { CloudStorageBackend } from './cloud-storage-backend.mjs'
import { createGrantLogService } from './grant-log.mjs'
import { createKeyDistributionService } from './key-distribution.mjs'
import { createManifestSyncService } from './manifest-sync.mjs'
import { createChunkReplicationService } from './chunk-replication.mjs'

/** Default bound (ms) `get()` waits for a key's manifest entry to appear locally before giving up -- see module doc comment, point 2. */
const DEFAULT_MANIFEST_WAIT_MS = 3000

/** How often `get()`'s bounded wait re-polls the local manifest snapshot. */
const MANIFEST_POLL_INTERVAL_MS = 25

/** Bare action-scopes `becomeAdmin()` self-grants beyond the `admin` scope `GrantLog.bootstrapAdmin()` itself grants -- see module doc comment, point 3. */
const SELF_GRANT_ACTIONS = ['read', 'write', 'delete', 'list']

/** @param {string} bucket @returns {string} The scope-grammar resource string GrantLog/PeerRegistry/manifest-sync/chunk-replication all expect. */
function resourceFor(bucket) {
  return `s3:${bucket}`
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `get()` when a key is not found locally after the bounded
 * manifest wait (see module doc comment, point 2). `.reason` is
 * `'not-found'` (the key never appeared) or `'deleted'` (it appeared, but
 * tombstoned).
 */
export class CloudStorageNotFoundError extends Error {
  /**
   * @param {string} key
   * @param {object} [opts]
   * @param {'not-found'|'deleted'} [opts.reason='not-found']
   */
  constructor(key, { reason = 'not-found' } = {}) {
    super(
      reason === 'deleted'
        ? `CloudStorage: key '${key}' was deleted`
        : `CloudStorage: key '${key}' not found (it may simply not exist, or its manifest entry has not synced to this peer yet)`,
    )
    this.name = 'CloudStorageNotFoundError'
    this.key = key
    this.reason = reason
  }
}

// ---------------------------------------------------------------------------
// base64 / bytes helpers -- deliberately duplicated rather than shared,
// matching this family's established per-file convention (see
// cloud-storage-backend.mjs / key-distribution.mjs / chunk-replication.mjs,
// all of which independently define the exact same pair).
// ---------------------------------------------------------------------------

/** @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** @param {string} str @returns {Uint8Array} */
function fromBase64(str) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'))
  const bin = atob(str)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * Normalize `put()`'s `data` argument (a `Uint8Array`, `ArrayBuffer`, or
 * `string`) into bytes.
 * @param {Uint8Array|ArrayBuffer|string} data
 * @returns {Uint8Array}
 */
function toUint8Array(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (typeof data === 'string') return new TextEncoder().encode(data)
  throw new TypeError('CloudStorage.put: data must be a Uint8Array, ArrayBuffer, or string')
}

// ---------------------------------------------------------------------------
// CloudStorage
// ---------------------------------------------------------------------------

/**
 * The ergonomic, S3-like object storage class. See this file's module doc
 * comment for the full design writeup.
 */
export class CloudStorage {
  /** @type {string} */
  #bucket

  /** @type {string} */
  #resource

  /** @type {object} Duck-typed `{podId, wallet, registry, sendTo, onIncomingData}` -- see module doc comment, point 7. */
  #node

  /** @type {import('@johnhenry/browsermesh-netway').VirtualNetwork|null} */
  #network

  /** @type {CloudStorageBackend} */
  #backend

  /** @type {import('@johnhenry/browsermesh-netway').StreamSocket|null} lazily-opened private local socket to `#backend` */
  #socket = null

  /** @type {Promise<void>} tail of the local-socket command queue -- see #sendCommand() */
  #socketQueue = Promise.resolve()

  /** @type {{resource: string, grant: Function, revoke: Function, bootstrapAdmin: Function, syncWith: Function, effective: Function, toJSON: Function}} set synchronously during construction */
  #grantLogApi

  /** @type {{resource: string, handleGrantChange: Function, localEncryptionPublicKey: Function}} */
  #keyDistApi

  /** @type {{bucketId: string, docId: string, watch: Function, unwatch: Function, syncWith: Function}} */
  #manifestSyncApi

  /** @type {{bucketId: string, resource: string, fetchChunk: Function, syncMissingChunks: Function, listReplicaPeers: Function}} */
  #chunkReplicationApi

  /** @type {Array<{name: string, backendScheme: string|null, api: object|undefined, teardown: () => Promise<void>}>} */
  #handles = []

  /** @type {string[]} */
  #replicaPeers

  /** @type {number} */
  #replicationFactor

  /** @type {number} */
  #manifestWaitMs

  /** @type {Function} */
  #onLog

  /** @type {import('./mesh-service.mjs').EventBus} This class's OWN higher-level event bus -- see module doc comment's "Observability events" section. Not the same bus as any of the four internally-attached services' own `ctx.emit()`. */
  #events = createEventBus()

  /**
   * @param {object} opts
   * @param {string} opts.bucket - Bucket name. The ACL/sync resource used
   *   throughout is `s3:<bucket>`.
   * @param {object} opts.node - A booted `PeerNode` (or any object providing
   *   the same minimal surface -- see module doc comment, point 7).
   * @param {import('@johnhenry/browsermesh-netway').VirtualNetwork} [opts.network] -
   *   Optional -- see module doc comment, point 1. Only used to additionally
   *   register the internal `CloudStorageBackend` on it for raw JSON-command
   *   socket access.
   * @param {string} [opts.backendScheme] - Scheme `#backend` is registered
   *   under on `network`, if supplied. Defaults to `s3-<bucket>`.
   * @param {string[]} [opts.replicaPeers] - PubKeys to designate as replicas
   *   immediately when `becomeAdmin()` is called (see module doc comment,
   *   point 3). Ignored if `becomeAdmin()` is never called.
   * @param {number} [opts.replicationFactor] - Advisory only -- see module
   *   doc comment, point 6.
   * @param {number} [opts.manifestWaitMs] - Default bound for `get()`'s
   *   "wait for the manifest to sync" behavior (see module doc comment,
   *   point 2). Defaults to `DEFAULT_MANIFEST_WAIT_MS`.
   * @param {Function} [opts.onLog]
   * @param {string} [opts.dbName] - Passed through to `CloudStorageBackend`
   *   (its IndexedDB database name prefix). Defaults to `cloud-storage-<bucket>`.
   * @param {import('@johnhenry/browsermesh-sync').IndexedDBChunkStore} [opts.chunkStore]
   * @param {import('@johnhenry/browsermesh-sync').IndexedDBSyncStorage} [opts.manifestStorage]
   * @param {import('@johnhenry/browsermesh-sync').IndexedDBSyncStorage} [opts.keyStorage]
   */
  constructor({
    bucket,
    node,
    network,
    backendScheme,
    replicaPeers = [],
    replicationFactor,
    manifestWaitMs = DEFAULT_MANIFEST_WAIT_MS,
    onLog,
    dbName,
    chunkStore,
    manifestStorage,
    keyStorage,
  } = {}) {
    if (!bucket || typeof bucket !== 'string') {
      throw new Error('CloudStorage: bucket is required and must be a non-empty string')
    }
    if (!node || typeof node !== 'object') {
      throw new Error('CloudStorage: node is required (a booted PeerNode, or an equivalent duck-typed object)')
    }
    if (!node.podId || typeof node.podId !== 'string') {
      throw new Error('CloudStorage: node.podId is required')
    }
    if (!node.wallet || typeof node.wallet.sign !== 'function') {
      throw new Error('CloudStorage: node.wallet is required (needed by the GrantLog/key-distribution services)')
    }
    if (!node.registry || typeof node.registry.checkAccess !== 'function') {
      throw new Error('CloudStorage: node.registry is required (needed by manifest-sync/chunk-replication for ACL checks)')
    }

    this.#bucket = bucket
    this.#resource = resourceFor(bucket)
    this.#node = node
    this.#network = network || null
    this.#replicaPeers = Array.isArray(replicaPeers) ? [...replicaPeers] : []
    this.#replicationFactor = typeof replicationFactor === 'number' ? replicationFactor : this.#replicaPeers.length
    this.#manifestWaitMs = manifestWaitMs
    this.#onLog = onLog || (() => {})

    if (this.#replicationFactor > this.#replicaPeers.length) {
      this.#onLog('cloud-storage:replication-factor-not-met', {
        bucket, replicationFactor: this.#replicationFactor, replicaPeersProvided: this.#replicaPeers.length,
      })
    }

    this.#backend = new CloudStorageBackend({
      bucket,
      dbName,
      chunkStore,
      manifestStorage,
      keyStorage,
      nodeId: node.podId,
      onLog: this.#onLog,
    })

    if (this.#network) {
      this.#network.addBackend(backendScheme || `s3-${bucket}`, this.#backend)
    }

    // -- Compose D/E/F/G. Order matters for D+E -- see grant-log.mjs's own
    // "Composition with createGrantLogService()" doc-comment section, and
    // key-distribution.test.mjs's `attachBucketServices()` fixture, which
    // this mirrors exactly.
    let grantLogApi
    const keyDistHandle = attachService(node, network, createKeyDistributionService({
      resource: this.#resource,
      getEffective: () => grantLogApi.effective(),
      getLocalKey: () => this.#backend.peekKeyRaw(),
      setReceivedKey: (bytes) => this.#backend.importKeyRaw(bytes),
      onLog: this.#onLog,
    }))
    const grantLogHandle = attachService(node, network, createGrantLogService({
      resource: this.#resource,
      onGrantChange: keyDistHandle.api.handleGrantChange,
      onReady: (api) => { grantLogApi = api },
      onLog: this.#onLog,
    }))
    // `onReady` above runs synchronously inside `attach()` (see
    // grant-log.mjs's own doc comment on why it must), so `grantLogApi` is
    // already assigned by the time `attachService()` returns.
    this.#grantLogApi = grantLogApi
    this.#keyDistApi = keyDistHandle.api

    const manifestSyncHandle = attachService(node, network, createManifestSyncService({
      bucketId: bucket,
      cloudStorageBackend: this.#backend,
      onLog: this.#onLog,
    }))
    this.#manifestSyncApi = manifestSyncHandle.api

    const chunkReplicationHandle = attachService(node, network, createChunkReplicationService({
      bucketId: bucket,
      cloudStorageBackend: this.#backend,
      onLog: this.#onLog,
    }))
    this.#chunkReplicationApi = chunkReplicationHandle.api

    this.#handles = [keyDistHandle, grantLogHandle, manifestSyncHandle, chunkReplicationHandle]
  }

  /** The bucket name this instance serves. */
  get bucket() { return this.#bucket }

  /** The scope-grammar resource string (`s3:<bucket>`) this instance's ACL/sync services check against. */
  get resource() { return this.#resource }

  /** Advisory only -- see module doc comment, point 6. */
  get replicationFactor() { return this.#replicationFactor }

  /**
   * Subscribe to exactly one of this instance's own higher-level events
   * (`cloud-storage:*` -- see module doc comment's "Observability events"
   * section). Matches `attachService()`'s returned handle's `on()` shape.
   * @param {string} event
   * @param {(data: object) => void} callback
   * @returns {() => void} Unsubscribe function.
   */
  on(event, callback) {
    return this.#events.on(event, callback)
  }

  /**
   * Subscribe to every event this instance emits, regardless of name.
   * Matches `attachService()`'s returned handle's `onEvent()` shape.
   * @param {(event: string, data: object) => void} callback
   * @returns {() => void} Unsubscribe function.
   */
  onEvent(callback) {
    return this.#events.onEvent(callback)
  }

  // -----------------------------------------------------------------------
  // Local command socket (put/get/delete/list all flow through here)
  // -----------------------------------------------------------------------

  /** @returns {Promise<import('@johnhenry/browsermesh-netway').StreamSocket>} */
  async #ensureSocket() {
    if (!this.#socket) {
      this.#socket = await this.#backend.connect()
    }
    return this.#socket
  }

  /**
   * Send one JSON command to `#backend` over its private local socket and
   * return its one JSON response. The wire protocol (`fs-service-backend.mjs`'s
   * convention, reused by `CloudStorageBackend`) has no request-id
   * correlation -- it is strictly one command in flight at a time -- so
   * concurrent callers of this class share one FIFO queue rather than
   * risking interleaved writes/misattributed reads on the same socket.
   * @param {object} cmd
   * @returns {Promise<object>}
   */
  #sendCommand(cmd) {
    const run = async () => {
      const socket = await this.#ensureSocket()
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()
      await socket.write(encoder.encode(JSON.stringify(cmd)))
      const chunk = await socket.read()
      if (chunk === null) {
        throw new Error('CloudStorage: local backend socket closed unexpectedly')
      }
      return JSON.parse(decoder.decode(chunk))
    }

    const result = this.#socketQueue.then(run, run)
    // Keep the queue itself always-resolved regardless of a given command's
    // outcome -- only `result` (returned below) carries the real
    // success/failure for THIS call.
    this.#socketQueue = result.then(() => {}, () => {})
    return result
  }

  // -----------------------------------------------------------------------
  // Object operations
  // -----------------------------------------------------------------------

  /**
   * Write `data` under `key`. The local write is always durable by the time
   * this resolves (Phase G's durability contract) -- `durability`/
   * `replicatedTo` report whether it was ALSO pushed to connected,
   * admin-designated replica peers in time, never whether the local write
   * itself succeeded.
   *
   * @param {string} key
   * @param {Uint8Array|ArrayBuffer|string} data
   * @param {object} [opts]
   * @param {string} [opts.contentType]
   * @param {object} [opts.metadata]
   * @returns {Promise<{stored: true, key: string, size: number, durability: 'local-only'|'replicated', replicatedTo: string[]}>}
   */
  async put(key, data, opts = {}) {
    if (!key || typeof key !== 'string') {
      throw new Error('CloudStorage.put: key is required and must be a non-empty string')
    }
    const bytes = toUint8Array(data)
    const res = await this.#sendCommand({
      op: 'put',
      key,
      data: toBase64(bytes),
      contentType: opts.contentType ?? null,
      metadata: opts.metadata ?? {},
    })
    if (res.error) throw new Error(`CloudStorage.put: ${res.error}`)
    const durability = res.durability === 'replicated' ? 'replicated' : 'local-only'
    this.#events.emit('cloud-storage:put-completed', { bucket: this.#bucket, key: res.key, size: res.size, durability })
    return {
      stored: true,
      key: res.key,
      size: res.size,
      durability,
      replicatedTo: Array.isArray(res.replicatedTo) ? res.replicatedTo : [],
    }
  }

  /**
   * Wait (up to `waitMs`) for `key`'s manifest entry to be present, per the
   * module doc comment's point 2 ("the manifest entry itself isn't here
   * yet"). Shared by `getObject()` and `stat()` so both honor the same
   * manifest-sync-wait/tombstone contract as each other.
   *
   * @param {string} key
   * @param {number} waitMs
   * @returns {Promise<object>} the manifest registration entry
   * @throws {CloudStorageNotFoundError}
   */
  async #awaitManifestEntry(key, waitMs) {
    const deadline = Date.now() + waitMs

    let reg = null
    while (true) {
      const snapshot = await this.#backend.getManifestSnapshot()
      reg = snapshot?.entries?.[key] || null
      if (reg) break
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, MANIFEST_POLL_INTERVAL_MS))
    }

    if (!reg) {
      throw new CloudStorageNotFoundError(key, { reason: 'not-found' })
    }
    if (reg.tombstone) {
      throw new CloudStorageNotFoundError(key, { reason: 'deleted' })
    }
    return reg
  }

  /**
   * Read `key`'s content plus the `contentType`/`metadata` it was `put()`
   * with. The backend's `get` op already returns these fields
   * (`cloud-storage-backend.mjs`'s `#opGet()`) -- `get()` below is a thin
   * wrapper around this that returns only `data`, for callers that don't
   * need the rest. Falls back to a remote peer request (Phase G's lazy
   * pull/read-repair) for any chunk not already held locally.
   *
   * @param {string} key
   * @param {object} [opts]
   * @param {number} [opts.manifestWaitMs] - Overrides the constructor default for this call only.
   * @returns {Promise<{data: Uint8Array, contentType: (string|undefined), metadata: (object|undefined)}>}
   * @throws {CloudStorageNotFoundError}
   */
  async getObject(key, opts = {}) {
    if (!key || typeof key !== 'string') {
      throw new Error('CloudStorage.getObject: key is required and must be a non-empty string')
    }
    const waitMs = opts.manifestWaitMs ?? this.#manifestWaitMs
    const reg = await this.#awaitManifestEntry(key, waitMs)

    // Ensure every chunk this entry references is present locally BEFORE
    // asking the backend to decrypt+assemble it -- the backend itself has
    // no notion of "go fetch it from the mesh", only "read what I already
    // have" (see cloud-storage-backend.mjs's #fetchAndDecrypt()).
    for (const { cid } of reg.value?.chunks || []) {
      const has = await this.#backend.hasChunkRaw(cid)
      if (!has) {
        await this.#chunkReplicationApi.fetchChunk(cid) // throws a plain Error if unreachable -- propagated as-is, not wrapped
      }
    }

    const res = await this.#sendCommand({ op: 'get', key })
    if (res.error) {
      // The manifest could have raced a concurrent delete between the check
      // above and now -- surface it via the same not-found contract rather
      // than a raw backend error string.
      throw new CloudStorageNotFoundError(key, { reason: 'deleted' })
    }
    this.#events.emit('cloud-storage:get-completed', { bucket: this.#bucket, key })
    return { data: fromBase64(res.data), contentType: res.contentType, metadata: res.metadata }
  }

  /**
   * Read `key`'s content. See `getObject()` for the `contentType`/`metadata`-
   * preserving variant this delegates to.
   *
   * @param {string} key
   * @param {object} [opts]
   * @param {number} [opts.manifestWaitMs] - Overrides the constructor default for this call only.
   * @returns {Promise<Uint8Array>}
   * @throws {CloudStorageNotFoundError}
   */
  async get(key, opts = {}) {
    const { data } = await this.getObject(key, opts)
    return data
  }

  /**
   * Return `key`'s metadata (`size`, `contentType`, `metadata`, `updatedAt`,
   * `version`) without reading or decrypting its content. Thin wrapper
   * around the backend's existing `head` op (`cloud-storage-backend.mjs`'s
   * `#opHead()`), which was already implemented but never called from this
   * class.
   *
   * @param {string} key
   * @param {object} [opts]
   * @param {number} [opts.manifestWaitMs] - Overrides the constructor default for this call only.
   * @returns {Promise<{size: number, contentType: (string|undefined), metadata: (object|undefined), updatedAt: number, version: number}>}
   * @throws {CloudStorageNotFoundError}
   */
  async stat(key, opts = {}) {
    if (!key || typeof key !== 'string') {
      throw new Error('CloudStorage.stat: key is required and must be a non-empty string')
    }
    const waitMs = opts.manifestWaitMs ?? this.#manifestWaitMs
    await this.#awaitManifestEntry(key, waitMs)

    const res = await this.#sendCommand({ op: 'head', key })
    if (res.error) {
      throw new CloudStorageNotFoundError(key, { reason: 'deleted' })
    }
    return { size: res.size, contentType: res.contentType, metadata: res.metadata, updatedAt: res.updatedAt, version: res.version }
  }

  /**
   * Delete `key` (a tombstone, per `CloudStorageBackend`'s manifest --
   * never a chunk-store removal; see that file's own doc comment).
   * @param {string} key
   * @returns {Promise<{deleted: true}>}
   */
  async delete(key) {
    if (!key || typeof key !== 'string') {
      throw new Error('CloudStorage.delete: key is required and must be a non-empty string')
    }
    const res = await this.#sendCommand({ op: 'delete', key })
    if (res.error) throw new Error(`CloudStorage.delete: ${res.error}`)
    this.#events.emit('cloud-storage:delete-completed', { bucket: this.#bucket, key })
    return { deleted: true }
  }

  /**
   * List keys, optionally filtered by `prefix`. Reflects this peer's own
   * local manifest state at call time -- eventually consistent with other
   * peers, exactly like real S3 listing, with no special wait (unlike
   * `get()`; see module doc comment, point 2 -- listing has no single key
   * whose absence is ambiguous the way `get()` does).
   * @param {string} [prefix='']
   * @returns {Promise<Array<{key: string, size: number, updatedAt: number}>>}
   */
  async list(prefix = '') {
    const res = await this.#sendCommand({ op: 'list', prefix })
    if (res.error) throw new Error(`CloudStorage.list: ${res.error}`)
    return res.keys
  }

  // -----------------------------------------------------------------------
  // Bucket admin
  // -----------------------------------------------------------------------

  /**
   * Bootstrap this identity as the bucket's admin, and self-grant
   * `read`/`write`/`delete`/`list` (see module doc comment, point 3). Only
   * call this when THIS instance is genuinely creating a brand-new bucket.
   * If `replicaPeers` was supplied to the constructor, each is designated a
   * replica immediately afterward.
   * @returns {Promise<void>}
   */
  async becomeAdmin() {
    await this.#grantLogApi.bootstrapAdmin()
    await this.#grantLogApi.grant(this.#node.podId, SELF_GRANT_ACTIONS)
    this.#events.emit('cloud-storage:admin-bootstrapped', { bucket: this.#bucket })
    for (const pubKey of this.#replicaPeers) {
      await this.designateReplica(pubKey)
    }
  }

  /**
   * Grant `pubKey` one or more bare capability actions on this bucket
   * (`'read'`, `'write'`, `'delete'`, `'list'`, `'admin'`, `'replica'`).
   * Requires this instance's identity to currently be an authorized admin
   * of this bucket (enforced by `GrantLog.grant()` itself). See module doc
   * comment, point 4, for why this also drives manifest visibility/sync.
   * @param {string} pubKey
   * @param {string|string[]} scopes
   * @returns {Promise<void>}
   */
  async grant(pubKey, scopes) {
    const list = Array.isArray(scopes) ? scopes : [scopes]
    await this.#grantLogApi.grant(pubKey, list)
    await this.#grantLogApi.syncWith(pubKey)
    this.#manifestSyncApi.watch(pubKey)
    // KNOWN RACE, worked around here rather than ignored: the recipient's
    // GrantLog.mergeRemote() (crypto signature verification, genuinely
    // async) is not awaited by their own grant-log service's dispatch
    // handler (matching `manifest-sync.mjs`'s/`grant-log.mjs`'s own
    // established "handle async work in a .catch()-guarded background
    // promise, never block the dispatch loop" convention) -- so a manifest
    // sync sent immediately after `grantLogApi.syncWith()` can arrive and be
    // ACL-checked on the recipient's side BEFORE their own registry has
    // actually been updated with this grant, and gets silently rejected by
    // manifest-sync.mjs's gate. Without a retry, pre-existing content would
    // then only ever become visible to the recipient on the NEXT write (the
    // first one to be broadcast after the grant has genuinely landed) --
    // fine for future writes, not for content that already existed at grant
    // time. A CRDT manifest merge is idempotent, so resending it a few times
    // at increasing delays is a cheap, safe way to self-heal this race
    // without needing an acknowledgement protocol this phase doesn't have.
    for (const delayMs of [0, 20, 150]) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      await this.#manifestSyncApi.syncWith(pubKey)
    }
    this.#events.emit('cloud-storage:grant-issued', { bucket: this.#bucket, pubKey, scopes: list })
  }

  /**
   * Revoke `pubKey`'s one or more bare capability actions on this bucket.
   * See `cloud-storage-backend.mjs`'s and `key-distribution.mjs`'s own
   * documented PERMANENT LIMITATION: this stops FUTURE key distribution and
   * chunk replication to `pubKey`, but cannot retroactively erase a bucket
   * key (or plaintext) already delivered to them before the revoke.
   * @param {string} pubKey
   * @param {string|string[]} scopes
   * @returns {Promise<void>}
   */
  async revoke(pubKey, scopes) {
    const list = Array.isArray(scopes) ? scopes : [scopes]
    await this.#grantLogApi.revoke(pubKey, list)
    await this.#grantLogApi.syncWith(pubKey)
    this.#manifestSyncApi.unwatch(pubKey)
  }

  /**
   * Convenience for `grant(pubKey, 'replica')` -- see module doc comment,
   * point 5.
   * @param {string} pubKey
   * @returns {Promise<void>}
   */
  async designateReplica(pubKey) {
    await this.grant(pubKey, 'replica')
  }

  /**
   * Introspection: this bucket's current admins and per-pubKey effective
   * grants, per the last locally-replayed `GrantLog` state.
   * @returns {{admins: string[], grants: Object<string, string[]>}}
   */
  effectiveGrants() {
    return this.#grantLogApi.effective()
  }

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  /**
   * Detach every internally-composed service and close the local backend.
   * Does not (cannot -- see `mesh-service.mjs`'s own documented limitation)
   * remove `#backend` from `network` if it was registered there.
   * @returns {Promise<void>}
   */
  async close() {
    if (this.#socket) {
      await this.#socket.close().catch(() => {})
      this.#socket = null
    }
    for (const handle of this.#handles) {
      try {
        await handle.teardown()
      } catch (err) {
        this.#onLog('cloud-storage:teardown-error', { bucket: this.#bucket, service: handle.name, error: err?.message || String(err) })
      }
    }
    await this.#backend.close()
    this.#events.closeAll()
  }
}

export { DEFAULT_MANIFEST_WAIT_MS }
