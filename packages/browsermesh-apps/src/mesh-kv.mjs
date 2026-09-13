/**
 * mesh-kv.mjs -- Phase 3 of the mesh-KV-and-observability plan
 * (`mesh-kv-and-observability.md`, "Design decisions", "The KV store is
 * deliberately smaller than CloudStorage"): a mesh-native, replicated
 * key-value store. `LWWMap`-backed (the same CRDT `cloud-storage.mjs`'s
 * manifest already uses), ACL-gated via `createGrantLogService()`
 * (`grant-log.mjs`, reused directly, unmodified) under
 * `kv:<storeId>:{read,write,admin}` scopes -- NO chunking, NO
 * content-addressing, NO encryption-at-rest. The plan is explicit that this
 * is a deliberate scope cut, not an oversight: small, low-sensitivity shared
 * state is the target use case (examples/docs needing a piece of shared
 * mesh state to demonstrate with), not a CloudStorage replacement.
 *
 * ---------------------------------------------------------------------------
 * RELATIONSHIP TO `manifest-sync.mjs` (read that file's module doc comment
 * first -- this one assumes it):
 *
 * `manifest-sync.mjs` is the closest structural precedent, but it is NOT
 * generic enough to reuse directly as a class: it is hard-wired to
 * `CloudStorageBackend` as a SEPARATE, independently-durable data source it
 * has to keep mirroring (`getManifestSnapshot()`/`onManifestChange()`/
 * `mergeManifestEntries()`), because that backend's manifest is persisted
 * via its own `IndexedDBSyncStorage` and encryption pipeline -- the
 * `MeshSyncEngine` in that file is purely a sync/broadcast VEHICLE mirroring
 * an already-durable, already-authoritative copy that lives elsewhere.
 *
 * This store has no such second source of truth: there is no chunk store, no
 * encryption, no separate durable backend to mirror. The `MeshSyncEngine`'s
 * own `LWWMap` (`InMemorySyncStorage`-backed, in-process) IS the store's
 * authoritative state, directly. That single fact eliminates an entire
 * category of code `manifest-sync.mjs` needs (no `refreshEngineFromBackend()`
 * step, no "did the backend's mutation land before I broadcast" ordering
 * concern, no separate on-change hook to bridge local writes into the
 * engine -- `MeshSyncEngine.update()` already notifies subscribers itself,
 * so this file's local `set()`/`delete()` calling `engine.update()` directly
 * IS the local-write-triggers-broadcast path, with no bridging in between).
 *
 * What IS reused near-verbatim from `manifest-sync.mjs`, because the
 * property being enforced is identical regardless of what the CRDT holds:
 * the wire-payload-layer ACL gate. `MeshSyncEngine.merge()` has no concept
 * of trust (see `manifest-sync.mjs`'s "THE CORE DESIGN CONSTRAINT"), so the
 * gate lives here, one layer above, walking `payload.crdt.entries` BEFORE
 * any byte reaches `engine.merge()`: each entry's `nodeId` (the implied
 * writer, exactly the field `LWWRegister`/`LWWMap.toJSON()` already carries)
 * must equal the connection-authenticated sender (`fromPubKey`, rejecting
 * `attribution-mismatch` otherwise -- a peer cannot claim to relay a write it
 * did not itself send, same limitation `manifest-sync.mjs` documents: no
 * multi-hop relay/gossip trust chain exists in this phase either), AND that
 * sender must pass `ctx.registry.checkAccess(writer, 'kv:<storeId>', 'write')`
 * (rejecting `unauthorized` otherwise). Only entries that pass BOTH checks
 * ever reach `engine.merge()`. A key with no surviving entries after
 * filtering is a no-op for that merge call.
 *
 * `read`/`admin` scopes are NOT independently enforced by an ACL check
 * anywhere in this file's push path -- exactly the same, already-accepted
 * shape `cloud-storage.mjs`'s own module doc comment documents for its
 * `read`/`list` scopes (see that file's "KNOWN LIMITATION" section): "read"
 * access is enforced socially/administratively, by an admin choosing who to
 * `watch()`/`grant()` in the first place, not by a per-message gate on the
 * receiving side. `write` is the one scope with a real, always-on
 * enforcement point (the merge gate above) because it is the one property a
 * receiving peer MUST be able to verify unilaterally, from data it already
 * has (its own registry), independent of which peers it has chosen to trust
 * enough to watch.
 *
 * ---------------------------------------------------------------------------
 * Two layers, mirroring `cloud-storage.mjs`'s own composition pattern
 * (`createGrantLogService()` + a data-sync `MeshService`, composed by one
 * higher-level class) rather than `cloud-storage.mjs`'s full four-service
 * stack (no key-distribution, no chunk-replication -- there is no
 * encryption key to distribute and no chunk to replicate):
 *
 *   - `createMeshKvService()` -- the low-level `MeshService` descriptor
 *     (`mesh-service.mjs`, Phase C). Wire-compatible with being attached
 *     standalone (its `api` is `{storeId, docId, resource, get, set,
 *     delete, keys, watch, unwatch, syncWith}`), for a caller that wants the
 *     bare service the way `manifest-sync.test.mjs`/`grant-log.test.mjs`
 *     attach their services directly rather than through a wrapper class.
 *   - `MeshKv` -- the ergonomic wrapper class (this phase's answer to the
 *     plan's open question, see below), composing
 *     `createGrantLogService({resource: 'kv:<storeId>'})` +
 *     `createMeshKvService({storeId})`, mirroring exactly how `grant()`/
 *     `revoke()` in `cloud-storage.mjs` also drive `manifestSyncApi.watch()`/
 *     `unwatch()` and an immediate grant-log + data `syncWith()` (including
 *     the same documented retry-on-delay workaround for the same race: the
 *     recipient's `GrantLog.mergeRemote()` is not awaited by its own
 *     dispatch handler, so a data push sent immediately after
 *     `grantLogApi.syncWith()` can arrive and be ACL-checked before the
 *     recipient's registry has actually absorbed the grant -- see
 *     `cloud-storage.mjs`'s `grant()` for the identical comment, reused
 *     verbatim here because the failure mode is identical).
 *
 * ---------------------------------------------------------------------------
 * PUBLIC API DECISION (the plan's own open question, "decide whether this
 * needs a separate ergonomic wrapper class... or whether the composed
 * service's own `api`... is already clean enough to use directly"):
 *
 * A thin wrapper class (`MeshKv`) was chosen, NOT because the bare
 * `attachService()` handle's `api` is unclean, but because -- exactly as
 * `cloud-storage.mjs`'s own doc comment argues for its four services --
 * composing two independently-attached services (`createGrantLogService()` +
 * `createMeshKvService()`) correctly requires wiring `grant()`/`revoke()` to
 * also drive `watch()`/`unwatch()`/an immediate `syncWith()` with the
 * documented retry, which is real, easy-to-get-wrong sequencing a caller
 * should not need to reimplement themselves every time. A caller who truly
 * wants the two bare services can still get them (`createMeshKvService()` is
 * exported standalone, exactly like `createManifestSyncService()` is), but
 * `MeshKv` is the documented, recommended entry point:
 *
 *   import { MeshKv } from '@johnhenry/browsermesh-apps'
 *   const kv = new MeshKv({ store: 'my-store', node: peerNode })
 *   await kv.becomeAdmin()
 *   await kv.set('key', 'value')
 *   const value = await kv.get('key')
 *
 * Per the task brief, the calling convention deliberately has NO
 * chunking-related concepts anywhere in this surface: `get`/`set`/`delete`/
 * `keys` are the entire data-plane API.
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`, Phase 1 of the mesh-KV-and-
 * observability plan -- see `mesh-service.mjs`'s module doc comment for the
 * full convention this follows). Five curated events on
 * `createMeshKvService()`'s own `attachService()` handle (the SAME
 * lower-level vocabulary `MeshKv` forwards, unchanged, onto its own
 * `on()`/`onEvent()` -- unlike `cloud-storage.mjs`, this store is small
 * enough that inventing a second, higher-level vocabulary on top would be
 * pure duplication rather than genuine abstraction):
 *
 *   - `mesh-kv:entry-set` `{storeId, from, key}` -- a key's live value
 *     changed, either from this peer's own `set()` (`from` = this peer's own
 *     podId) or from an authorized remote merge (`from` = the writer's
 *     podId).
 *   - `mesh-kv:entry-deleted` `{storeId, from, key}` -- a key was
 *     tombstoned, same "local or authorized remote" `from` convention as
 *     above.
 *   - `mesh-kv:write-rejected` `{storeId, from, key, reason}` -- one remote
 *     entry was dropped BEFORE merge (`reason` is `'attribution-mismatch'`
 *     or `'unauthorized'`), the exact security-relevant transition this
 *     file's ACL gate exists to enforce.
 *   - `mesh-kv:watching` `{storeId, pubKey}` -- `api.watch()` started
 *     broadcasting this store's changes to `pubKey`.
 *   - `mesh-kv:unwatching` `{storeId, pubKey}` -- `api.unwatch()` stopped.
 *
 * `grant-log:*` events (`grant-log:grant-applied`, etc.) are also available,
 * unchanged, on `MeshKv`'s internal `GrantLog` `attachService()` handle, but
 * are NOT forwarded onto `MeshKv`'s own `on()`/`onEvent()` -- a caller that
 * wants those subscribes to `createGrantLogService()` directly, matching how
 * `cloud-storage.mjs` also never forwards its four internal services' raw
 * event vocabularies onto its own higher-level bus verbatim.
 *
 * No browser-only imports at module level.
 */

import { MeshSyncEngine, InMemorySyncStorage } from '@johnhenry/browsermesh-sync'
import { attachService, createEventBus } from './mesh-service.mjs'
import { createGrantLogService } from './grant-log.mjs'

/** Default `envelope.type` used to route mesh-kv sync payloads on the shared `onIncomingData()` bus. */
const DEFAULT_ENVELOPE_TYPE = 'mesh-kv'

/** Bare action-scopes `MeshKv.becomeAdmin()` self-grants beyond the `admin` scope `GrantLog.bootstrapAdmin()` itself grants. */
const SELF_GRANT_ACTIONS = ['read', 'write']

/** @param {string} storeId @returns {string} */
function docIdFor(storeId) {
  return `kv:${storeId}`
}

/** @param {string} storeId @returns {string} The scope-grammar resource string GrantLog/PeerRegistry expect (`kv:<storeId>`). */
function resourceFor(storeId) {
  return `kv:${storeId}`
}

// ---------------------------------------------------------------------------
// createMeshKvService -- the low-level MeshService descriptor
// ---------------------------------------------------------------------------

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) that
 * replicates one key-value store's `LWWMap` across peers via a per-store
 * `MeshSyncEngine` `SyncDocument` (CRDT type `'lww-map'`), gating every
 * inbound remote mutation on `ctx.registry.checkAccess(writerPubKey,
 * 'kv:<storeId>', 'write')` before it ever reaches a merge -- see this
 * file's module doc comment for the full design.
 *
 * Unlike `createManifestSyncService()`, this service's `MeshSyncEngine` copy
 * IS the store's authoritative data -- there is no separate backend to keep
 * mirrored, so local `set()`/`delete()` write straight into the engine and
 * `engine.update()`'s own subscriber notification is what drives the
 * broadcast-to-watchers path.
 *
 * @param {object} opts
 * @param {string} opts.storeId - Store identifier. The synced document id
 *   and the ACL resource checked are both `kv:<storeId>`.
 * @param {string} [opts.envelopeType='mesh-kv']
 * @param {(api: {storeId: string, docId: string, resource: string,
 *   get: (key: string) => *, set: (key: string, value: *) => void,
 *   delete: (key: string) => void, keys: (prefix?: string) => string[],
 *   watch: (pubKey: string) => void, unwatch: (pubKey: string) => void,
 *   syncWith: (pubKey: string) => Promise<void>}) => void} [opts.onReady]
 *   Invoked synchronously inside `attach()` with the service's public API --
 *   same `onReady` workaround `createGrantLogService()`/
 *   `createManifestSyncService()` use (see those files' doc comments).
 *   New code should prefer the `{teardown, api}` return shape this
 *   descriptor also provides.
 * @param {Function} [opts.onLog]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createMeshKvService({ storeId, envelopeType = DEFAULT_ENVELOPE_TYPE, onReady, onLog } = {}) {
  if (!storeId || typeof storeId !== 'string') {
    throw new Error('createMeshKvService: storeId is required and must be a non-empty string')
  }

  const docId = docIdFor(storeId)
  const resource = resourceFor(storeId)
  const log = onLog || (() => {})

  return {
    name: `mesh-kv:${storeId}`,

    attach(peerNode, ctx) {
      const engine = new MeshSyncEngine({
        nodeId: peerNode.podId,
        storage: new InMemorySyncStorage(),
        onLog: log,
      })
      engine.create(docId, 'lww-map', { owner: peerNode.podId })

      /** @type {Set<string>} pubKeys this service broadcasts local/merged changes to. */
      const watchTargets = new Set()

      /** @type {number} monotonic clock backing local write timestamps -- see #nextTimestamp() below. */
      let clock = 0

      /**
       * A monotonic millisecond-ish clock for local `set()`/`delete()`
       * timestamps, duplicated from `cloud-storage-backend.mjs`'s own
       * `#nextTimestamp()` (same problem, same fix): plain `Date.now()` can
       * return the same value for two writes issued in the same
       * millisecond, and `LWWRegister.set()` only accepts a same-timestamp
       * write when the new writer's nodeId sorts strictly higher than the
       * current one -- so two same-millisecond LOCAL writes (e.g. `set()`
       * immediately followed by `delete()`, very possible under `node
       * --test`'s synchronous test bodies) would otherwise be silently
       * dropped, since both carry this same peer's own `nodeId`. Not a
       * substitute for the plan's documented caller-timestamp limitation
       * (still a real limitation across peers/instances) -- only ensures
       * THIS instance's own sequential writes are always strictly ordered.
       * @returns {number}
       */
      function nextTimestamp() {
        const now = Date.now()
        clock = now > clock ? now : clock + 1
        return clock
      }

      /**
       * @param {string} key
       * @param {boolean} tombstone
       * @param {string} from
       */
      function emitEntryChange(key, tombstone, from) {
        ctx.emit(tombstone ? 'mesh-kv:entry-deleted' : 'mesh-kv:entry-set', { storeId, from, key })
      }

      /**
       * Send this store's current state to one peer. Safe to call
       * repeatedly -- CRDT merge on the receiving end is idempotent.
       * @param {string} pubKey
       * @returns {Promise<void>}
       */
      async function syncWith(pubKey) {
        const payload = engine.prepareSyncPayload(docId)
        await ctx.sendTo(pubKey, envelopeType, { docId, payload })
      }

      // Broadcast to every watched peer whenever the engine's document
      // changes, whether from a local write (below) or an accepted remote
      // merge -- the latter is what makes multi-hop propagation possible.
      const unsubscribeBroadcast = engine.subscribe(docId, () => {
        for (const pubKey of watchTargets) {
          syncWith(pubKey).catch((err) => {
            log('mesh-kv:broadcast-failed', { storeId, to: pubKey, error: err?.message || String(err) })
          })
        }
      })

      // Remote input -- the ONLY path untrusted data enters this service.
      // See the module doc comment for why filtering happens here, on the
      // raw wire payload, strictly before any merge.
      const unsubscribeIncoming = ctx.onIncomingData(envelopeType, (fromPubKey, data) => {
        if (!data || data.docId !== docId || !data.payload || data.payload.type !== 'lww-map') return
        handleIncoming(fromPubKey, data.payload).catch((err) => {
          log('mesh-kv:merge-failed', { storeId, from: fromPubKey, error: err?.message || String(err) })
        })
      })

      /**
       * @param {string} fromPubKey
       * @param {object} payload - `MeshSyncEngine.prepareSyncPayload()` shape: `{id, type, crdt, version}`.
       */
      async function handleIncoming(fromPubKey, payload) {
        const rawEntries = payload?.crdt?.entries
        if (!rawEntries || typeof rawEntries !== 'object') return

        /** @type {Record<string, object>} */
        const sanitizedEntries = {}
        for (const [key, regState] of Object.entries(rawEntries)) {
          if (!regState || typeof regState !== 'object') continue
          const writer = regState.nodeId

          // The implied writer must equal the connection-authenticated
          // sender -- a peer cannot claim to relay a write it did not
          // itself send. See the module doc comment's ACL-gate section.
          if (writer !== fromPubKey) {
            log('mesh-kv:reject-attribution-mismatch', { storeId, key, from: fromPubKey, claimedWriter: writer })
            ctx.emit('mesh-kv:write-rejected', { storeId, from: fromPubKey, key, reason: 'attribution-mismatch' })
            continue
          }

          const check = ctx.registry.checkAccess(writer, resource, 'write')
          if (!check.allowed) {
            log('mesh-kv:reject-unauthorized-write', { storeId, key, from: fromPubKey, reason: check.reason })
            ctx.emit('mesh-kv:write-rejected', { storeId, from: fromPubKey, key, reason: 'unauthorized' })
            continue
          }

          sanitizedEntries[key] = regState
        }

        const mergedKeys = Object.keys(sanitizedEntries)
        if (mergedKeys.length === 0) return

        const sanitizedPayload = { ...payload, crdt: { entries: sanitizedEntries } }
        engine.merge(docId, sanitizedPayload)

        for (const key of mergedKeys) {
          emitEntryChange(key, Boolean(sanitizedEntries[key].tombstone), fromPubKey)
        }
      }

      const api = {
        storeId,
        docId,
        resource,

        /** @param {string} key @returns {*} The live value, or `undefined` if missing/deleted. */
        get(key) {
          return engine.get(docId).crdt.get(key)
        },

        /** @param {string} key @param {*} value */
        set(key, value) {
          engine.update(docId, (crdt) => crdt.set(key, value, nextTimestamp(), peerNode.podId))
          emitEntryChange(key, false, peerNode.podId)
        },

        /** @param {string} key */
        delete(key) {
          engine.update(docId, (crdt) => crdt.delete(key, nextTimestamp(), peerNode.podId))
          emitEntryChange(key, true, peerNode.podId)
        },

        /** @param {string} [prefix=''] @returns {string[]} Live keys, optionally filtered by prefix. */
        keys(prefix = '') {
          return [...engine.get(docId).crdt.keys()].filter((key) => key.startsWith(prefix))
        },

        /** Start broadcasting local/merged store changes to `pubKey`. */
        watch(pubKey) {
          watchTargets.add(pubKey)
          ctx.emit('mesh-kv:watching', { storeId, pubKey })
        },

        /** Stop broadcasting to `pubKey`. */
        unwatch(pubKey) {
          watchTargets.delete(pubKey)
          ctx.emit('mesh-kv:unwatching', { storeId, pubKey })
        },

        syncWith,
      }

      if (typeof onReady === 'function') onReady(api)

      return {
        api,
        teardown() {
          unsubscribeBroadcast()
          unsubscribeIncoming()
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// MeshKv -- the ergonomic wrapper class
// ---------------------------------------------------------------------------

/**
 * The ergonomic, small mesh-native key-value store. See this file's module
 * doc comment for the full design writeup and the "PUBLIC API DECISION"
 * section for why this wrapper exists.
 */
export class MeshKv {
  /** @type {string} */
  #store

  /** @type {string} */
  #resource

  /** @type {object} Duck-typed `{podId, wallet, registry, sendTo, onIncomingData}`, same minimal surface `cloud-storage.mjs`'s `CloudStorage` requires. */
  #node

  /** @type {{resource: string, grant: Function, revoke: Function, bootstrapAdmin: Function, syncWith: Function, effective: Function, toJSON: Function}} set synchronously during construction */
  #grantLogApi

  /** @type {{storeId: string, docId: string, resource: string, get: Function, set: Function, delete: Function, keys: Function, watch: Function, unwatch: Function, syncWith: Function}} */
  #kvApi

  /** @type {Array<{name: string, backendScheme: string|null, api: object|undefined, teardown: () => Promise<void>}>} */
  #handles = []

  /** @type {Function} */
  #unsubscribeForwardedEvents

  /** @type {Function} */
  #onLog

  /** @type {import('./mesh-service.mjs').EventBus} Forwards createMeshKvService()'s own `mesh-kv:*` vocabulary unchanged -- see module doc comment. */
  #events = createEventBus()

  /**
   * @param {object} opts
   * @param {string} opts.store - Store name. The ACL/sync resource used
   *   throughout is `kv:<store>`.
   * @param {object} opts.node - A booted `PeerNode` (or any object providing
   *   the same minimal surface -- `podId`, `wallet`, `registry`, `sendTo`,
   *   `onIncomingData`, matching `cloud-storage.mjs`'s `CloudStorage`).
   * @param {import('@johnhenry/browsermesh-netway').VirtualNetwork} [opts.network] -
   *   Optional. Neither internal service declares `createBackend`, so this
   *   is never required; passed through to `attachService()` only in case a
   *   future revision adds one.
   * @param {Function} [opts.onLog]
   */
  constructor({ store, node, network, onLog } = {}) {
    if (!store || typeof store !== 'string') {
      throw new Error('MeshKv: store is required and must be a non-empty string')
    }
    if (!node || typeof node !== 'object') {
      throw new Error('MeshKv: node is required (a booted PeerNode, or an equivalent duck-typed object)')
    }
    if (!node.podId || typeof node.podId !== 'string') {
      throw new Error('MeshKv: node.podId is required')
    }
    if (!node.wallet || typeof node.wallet.sign !== 'function') {
      throw new Error('MeshKv: node.wallet is required (needed by the GrantLog service)')
    }
    if (!node.registry || typeof node.registry.checkAccess !== 'function') {
      throw new Error('MeshKv: node.registry is required (needed by mesh-kv for ACL checks)')
    }

    this.#store = store
    this.#resource = resourceFor(store)
    this.#node = node
    this.#onLog = onLog || (() => {})

    // -- Compose GrantLog + mesh-kv. Order doesn't matter the way it does
    // for CloudStorage's GrantLog+key-distribution pair (no onGrantChange
    // consumer here), but GrantLog first matches this family's established
    // reading order (cloud-storage.mjs attaches key-distribution before
    // grant-log only because key-distribution's onGrantChange hook must
    // exist before grant-log's onReady fires; no such constraint here).
    let grantLogApi
    const grantLogHandle = attachService(node, network, createGrantLogService({
      resource: this.#resource,
      onReady: (api) => { grantLogApi = api },
      onLog: this.#onLog,
    }))
    this.#grantLogApi = grantLogApi

    const kvHandle = attachService(node, network, createMeshKvService({
      storeId: store,
      onLog: this.#onLog,
    }))
    this.#kvApi = kvHandle.api

    this.#unsubscribeForwardedEvents = kvHandle.onEvent((event, data) => this.#events.emit(event, data))

    this.#handles = [grantLogHandle, kvHandle]
  }

  /** The store name this instance serves. */
  get store() { return this.#store }

  /** The scope-grammar resource string (`kv:<store>`) this instance's ACL/sync services check against. */
  get resource() { return this.#resource }

  /**
   * Subscribe to exactly one `mesh-kv:*` event (see module doc comment's
   * "Observability events" section). Matches `attachService()`'s returned
   * handle's `on()` shape.
   * @param {string} event
   * @param {(data: object) => void} callback
   * @returns {() => void} Unsubscribe function.
   */
  on(event, callback) {
    return this.#events.on(event, callback)
  }

  /**
   * Subscribe to every `mesh-kv:*` event this instance emits, regardless of
   * name. Matches `attachService()`'s returned handle's `onEvent()` shape.
   * @param {(event: string, data: object) => void} callback
   * @returns {() => void} Unsubscribe function.
   */
  onEvent(callback) {
    return this.#events.onEvent(callback)
  }

  // -----------------------------------------------------------------------
  // Data operations -- deliberately small; no chunking-related concept
  // anywhere in this surface (see module doc comment).
  // -----------------------------------------------------------------------

  /**
   * Read `key`'s current value.
   * @param {string} key
   * @returns {Promise<*>} The live value, or `undefined` if missing/deleted.
   */
  async get(key) {
    if (!key || typeof key !== 'string') {
      throw new Error('MeshKv.get: key is required and must be a non-empty string')
    }
    return this.#kvApi.get(key)
  }

  /**
   * Write `value` under `key`.
   * @param {string} key
   * @param {*} value
   * @returns {Promise<{stored: true, key: string}>}
   */
  async set(key, value) {
    if (!key || typeof key !== 'string') {
      throw new Error('MeshKv.set: key is required and must be a non-empty string')
    }
    this.#kvApi.set(key, value)
    return { stored: true, key }
  }

  /**
   * Delete `key` (a tombstone -- never physically removed, matching
   * `LWWMap`'s own semantics).
   * @param {string} key
   * @returns {Promise<{deleted: true, key: string}>}
   */
  async delete(key) {
    if (!key || typeof key !== 'string') {
      throw new Error('MeshKv.delete: key is required and must be a non-empty string')
    }
    this.#kvApi.delete(key)
    return { deleted: true, key }
  }

  /**
   * List live keys, optionally filtered by `prefix`. Reflects this peer's
   * own local CRDT state at call time -- eventually consistent with other
   * peers, exactly like `CloudStorage.list()`.
   * @param {string} [prefix='']
   * @returns {Promise<string[]>}
   */
  async keys(prefix = '') {
    return this.#kvApi.keys(prefix)
  }

  // -----------------------------------------------------------------------
  // Store admin
  // -----------------------------------------------------------------------

  /**
   * Bootstrap this identity as the store's admin, and self-grant
   * `read`/`write` (mirroring `CloudStorage.becomeAdmin()`'s gap-fill --
   * see that file's module doc comment, point 3: bootstrapping admin
   * authority does not implicitly grant usage access to the bootstrapper's
   * own store). Only call this when THIS instance is genuinely creating a
   * brand-new store.
   * @returns {Promise<void>}
   */
  async becomeAdmin() {
    await this.#grantLogApi.bootstrapAdmin()
    await this.#grantLogApi.grant(this.#node.podId, SELF_GRANT_ACTIONS)
  }

  /**
   * Grant `pubKey` one or more bare capability actions on this store
   * (`'read'`, `'write'`, `'admin'`). Requires this instance's identity to
   * currently be an authorized admin of this store (enforced by
   * `GrantLog.grant()` itself). Also drives data visibility, mirroring
   * `CloudStorage.grant()` (see module doc comment): syncs the FULL grant
   * log to the recipient (so their own registry learns this admin's
   * pre-existing write grants too), starts watching them, and immediately
   * pushes the current store state with the same retry-on-delay workaround
   * `cloud-storage.mjs` documents for the identical async-merge race.
   * @param {string} pubKey
   * @param {string|string[]} scopes
   * @returns {Promise<void>}
   */
  async grant(pubKey, scopes) {
    const list = Array.isArray(scopes) ? scopes : [scopes]
    await this.#grantLogApi.grant(pubKey, list)
    await this.#grantLogApi.syncWith(pubKey)
    this.#kvApi.watch(pubKey)
    // Same known race/workaround as CloudStorage.grant() -- see that
    // file's module doc comment, point 4: the recipient's
    // GrantLog.mergeRemote() is not awaited by their own grant-log
    // service's dispatch handler, so a data push sent immediately after
    // grantLogApi.syncWith() can arrive and be ACL-checked before the
    // recipient's registry has actually absorbed the grant. CRDT merge is
    // idempotent, so resending at increasing delays is a cheap, safe
    // self-heal.
    for (const delayMs of [0, 20, 150]) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      await this.#kvApi.syncWith(pubKey)
    }
  }

  /**
   * Revoke `pubKey`'s one or more bare capability actions on this store.
   * @param {string} pubKey
   * @param {string|string[]} scopes
   * @returns {Promise<void>}
   */
  async revoke(pubKey, scopes) {
    const list = Array.isArray(scopes) ? scopes : [scopes]
    await this.#grantLogApi.revoke(pubKey, list)
    await this.#grantLogApi.syncWith(pubKey)
    this.#kvApi.unwatch(pubKey)
  }

  /**
   * Introspection: this store's current admins and per-pubKey effective
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
   * Detach both internally-composed services.
   * @returns {Promise<void>}
   */
  async close() {
    this.#unsubscribeForwardedEvents()
    for (const handle of this.#handles) {
      try {
        await handle.teardown()
      } catch (err) {
        this.#onLog('mesh-kv:teardown-error', { store: this.#store, service: handle.name, error: err?.message || String(err) })
      }
    }
    this.#events.closeAll()
  }
}

export { DEFAULT_ENVELOPE_TYPE }
