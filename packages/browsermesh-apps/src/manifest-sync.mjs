/**
 * manifest-sync.mjs -- Phase F of the mesh-native-services plan
 * ("Cross-peer manifest CRDT sync"): converts a `CloudStorageBackend`'s
 * per-bucket manifest (Phase B, an `LWWMap` persisted only via
 * `IndexedDBSyncStorage`, purely local) into a `MeshSyncEngine`
 * (`@johnhenry/browsermesh-sync`) `SyncDocument`, so it can actually merge
 * with other peers' copies of the same bucket's manifest over the mesh.
 *
 * Built as a `MeshService` (Phase C, `mesh-service.mjs`), following
 * `createGrantLogService()` (`grant-log.mjs`, Phase D) as the closest
 * existing precedent for "a `MeshService` that wraps a CRDT-synced
 * document" -- wire payloads travel over `ctx.onIncomingData()`/
 * `ctx.sendTo()`, filtered by `envelope.type`, exactly like
 * `mesh-sync.mjs`/`grant-log.mjs` already both do.
 *
 * ---------------------------------------------------------------------------
 * THE CORE DESIGN CONSTRAINT (read this before touching the merge path):
 *
 * A peer must NEVER blindly apply a remotely-received manifest mutation.
 * `MeshSyncEngine.merge()` (`browsermesh-sync/src/sync.mjs`) has no concept
 * of trust at all -- it just calls `doc.crdt.merge(remoteCrdt)` on whatever
 * `LWWMap` JSON it's handed. So the ACL gate cannot live inside
 * `MeshSyncEngine`; it has to live in THIS file, one layer above, applied to
 * the wire payload BEFORE it is ever handed to `engine.merge()` or to
 * `CloudStorageBackend.mergeManifestEntries()`.
 *
 * The wire format makes this tractable: `LWWMap.toJSON()` (and therefore
 * `MeshSyncEngine.prepareSyncPayload()`'s `crdt` field) is
 * `{entries: {key: {value, timestamp, nodeId, tombstone}}}` -- i.e. every
 * single key's register carries its own `nodeId`, the exact write-attribution
 * field `CloudStorageBackend` already sets to the *local peer's own identity*
 * when it puts/deletes a key (see that file's constructor doc comment for
 * why `nodeId` must be `peerNode.podId`, not the random-UUID default, for
 * this integration to work at all). That per-key `nodeId` is the "implied
 * writer" the plan's design section refers to.
 *
 * The approach taken here (one of the two the plan's own brief anticipated):
 * on receipt of a remote sync envelope, walk `payload.crdt.entries` BEFORE
 * calling any merge function, and for each entry independently check
 * `ctx.registry.checkAccess(entry.nodeId, 's3:<bucketId>', 'write')`. Any
 * entry whose implied writer fails that check is dropped from a *sanitized
 * copy* of the payload; only the surviving, ACL-passed entries are ever
 * handed to `engine.merge()` (to keep this service's own `MeshSyncEngine`
 * copy consistent, e.g. for later re-broadcast to other watching peers) and
 * to `cloudStorageBackend.mergeManifestEntries()` (the actual persisted
 * manifest every `get`/`list`/`head` op reads from). A key with NO surviving
 * entries after filtering is a no-op merge -- nothing reaches either the
 * engine or the backend for it. This is "merge into a scratch copy and only
 * accept per-key entries whose implied writer passes the check", applied at
 * the wire-payload layer rather than inside the CRDT itself, so `LWWMap`
 * needs zero changes and stays exactly as trust-agnostic as every other CRDT
 * in this family.
 *
 * Ordering, stated explicitly because it is the single most important
 * property of this file: the ACL check ALWAYS runs before ANY byte of a
 * remote entry touches `doc.crdt` or `CloudStorageBackend`'s manifest. There
 * is no code path where an unauthorized entry is merged first and evicted
 * later -- filtering happens on the plain-JSON wire payload, strictly prior
 * to constructing/merging any `LWWMap` instance from it.
 *
 * Known, deliberate limitation of this gate (distinct from the LWW
 * limitation below): manifest entries are NOT cryptographically signed the
 * way `GrantLog` records are (Phase D) -- `nodeId` is a plain, unauthenticated
 * string inside the LWW register. The defense this gate provides is against
 * a peer acting through its own real, connection-authenticated identity
 * (`ctx.onIncomingData()`'s `fromPubKey`, established at session/transport
 * level, the same trust boundary every other `MeshService` in this family
 * relies on) attempting to write manifest keys it was never granted access
 * to -- checked here by requiring `entry.nodeId === fromPubKey` in addition
 * to the ACL check itself, so a peer cannot claim to be relaying an
 * authorized third party's write it never actually received (there is no
 * multi-hop relay/gossip trust chain in this phase for that claim to ride
 * on). It does NOT add a cryptographic proof that a given LWW entry was
 * really authored by the identity it claims -- that would require signing
 * manifest entries the way GrantLog signs grant records, which the plan does
 * not call for in this phase and is not implemented here.
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED KNOWN LIMITATION -- LWW conflict resolution (matches the plan's
 * Design Decisions section and Phase B's manifest doc comment, restated here
 * because this is the phase that actually makes it observable cross-peer):
 *
 * `LWWMap` resolves conflicts at whole-value granularity using
 * CALLER-SUPPLIED timestamps, with a lexicographic-`nodeId` tiebreak on an
 * EXACT timestamp tie (`LWWRegister.merge()`: higher timestamp wins; on a
 * tie, the register whose `nodeId` string sorts greater wins). There is no
 * server-clock arbitration, no per-field merge, and no surfaced conflict --
 * two peers concurrently writing different content to the SAME key resolve
 * to ONE SILENT WINNER, chosen only by whichever combination of
 * (timestamp, nodeId) compares greater. This mirrors un-versioned S3's own
 * real default behavior (plain last-write-wins, no automatic versioning) and
 * is an accepted, stated limitation, not a bug to fix in this phase -- see
 * `test/manifest-sync.test.mjs`'s dedicated test demonstrating this exact,
 * deterministic (but not "correct" -- there is no correct answer here)
 * outcome.
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`, Phase 1 of the mesh-KV-and-
 * observability plan -- see `mesh-service.mjs`'s module doc comment for the
 * full convention this follows). Four curated events, not a mechanical
 * conversion of this file's `onLog` calls:
 *
 *   - `manifest-sync:entry-merged` `{bucketId, from, keys}` -- at least one
 *     remote manifest entry passed the ACL/attribution gate and was merged
 *     into both this service's own engine copy and the durable backend.
 *   - `manifest-sync:write-rejected` `{bucketId, from, key, reason}` -- one
 *     remote entry was dropped BEFORE merge (`reason` is
 *     `'attribution-mismatch'` or `'unauthorized'`); this is the gate this
 *     whole file exists to enforce, so its rejections are exactly the kind
 *     of security-relevant transition worth a dashboard being able to see.
 *   - `manifest-sync:watching` `{bucketId, pubKey}` -- `api.watch()` started
 *     broadcasting this bucket's changes to `pubKey`.
 *   - `manifest-sync:unwatching` `{bucketId, pubKey}` -- `api.unwatch()`
 *     stopped broadcasting to `pubKey`.
 *
 * No browser-only imports at module level.
 */

import { MeshSyncEngine, InMemorySyncStorage } from '@johnhenry/browsermesh-sync'
import { LWWMap } from '@johnhenry/browsermesh-primitives'

/** Default `envelope.type` used to route manifest-sync payloads on the shared `onIncomingData()` bus. */
const DEFAULT_ENVELOPE_TYPE = 'manifest-sync'

/** @param {string} bucketId @returns {string} */
function docIdFor(bucketId) {
  return `manifest:${bucketId}`
}

/** @param {string} bucketId @returns {string} The scope-grammar resource string GrantLog/PeerRegistry expect (`s3:<bucketId>`). */
function resourceFor(bucketId) {
  return `s3:${bucketId}`
}

// ---------------------------------------------------------------------------
// createManifestSyncService
// ---------------------------------------------------------------------------

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) that wires
 * a `CloudStorageBackend`'s manifest into a per-bucket `MeshSyncEngine`
 * `SyncDocument` (CRDT type `'lww-map'`), gating every inbound remote
 * mutation on `ctx.registry.checkAccess(writerPubKey, 's3:<bucketId>',
 * 'write')` before it ever reaches a merge -- see this file's module doc
 * comment for the full design.
 *
 * The `MeshSyncEngine` this creates uses in-memory storage: durability is
 * already `CloudStorageBackend`'s job (its manifest is persisted via its own
 * `IndexedDBSyncStorage`, Phase B); this service's engine is purely a
 * sync/broadcast vehicle mirroring that already-durable state, not a second
 * persistence layer for it.
 *
 * @param {object} opts
 * @param {string} opts.bucketId - Bucket identifier. The synced document id
 *   is `manifest:<bucketId>`; the ACL resource checked is `s3:<bucketId>`.
 * @param {import('./cloud-storage-backend.mjs').CloudStorageBackend} opts.cloudStorageBackend
 *   MUST have been constructed with `nodeId` equal to the attaching peer's
 *   own identity (`peerNode.podId`) -- see `cloud-storage-backend.mjs`'s
 *   constructor doc comment. Local writes made through this backend (its
 *   `put`/`delete` ops) are what gets broadcast to watched peers; remote,
 *   ACL-passed writes from other peers are merged back into it.
 * @param {string} [opts.envelopeType='manifest-sync']
 * @param {(api: {bucketId: string, docId: string, watch: (pubKey: string) => void,
 *   unwatch: (pubKey: string) => void, syncWith: (pubKey: string) => Promise<void>}) => void} [opts.onReady]
 *   Invoked synchronously inside `attach()` with the service's public API --
 *   same `onReady` workaround `createGrantLogService()` uses (see that
 *   file's doc comment) for getting a live handle back through
 *   `attachService()`, which does not await `attach()`'s return value. New
 *   code should prefer the `{teardown, api}` return shape this descriptor
 *   also provides (PR #83) over `onReady` where both are convenient.
 * @param {Function} [opts.onLog]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createManifestSyncService({ bucketId, cloudStorageBackend, envelopeType = DEFAULT_ENVELOPE_TYPE, onReady, onLog } = {}) {
  if (!bucketId || typeof bucketId !== 'string') {
    throw new Error('createManifestSyncService: bucketId is required and must be a non-empty string')
  }
  if (!cloudStorageBackend || typeof cloudStorageBackend.getManifestSnapshot !== 'function') {
    throw new Error('createManifestSyncService: cloudStorageBackend is required (a CloudStorageBackend instance)')
  }

  const docId = docIdFor(bucketId)
  const resource = resourceFor(bucketId)
  const log = onLog || (() => {})

  return {
    name: `manifest-sync:${bucketId}`,

    attach(peerNode, ctx) {
      const engine = new MeshSyncEngine({
        nodeId: peerNode.podId,
        storage: new InMemorySyncStorage(),
        onLog: log,
      })
      engine.create(docId, 'lww-map', { owner: peerNode.podId })

      /** @type {Set<string>} pubKeys this service broadcasts local/merged changes to. */
      const watchTargets = new Set()

      /**
       * Refresh the engine's copy of the manifest CRDT from
       * `cloudStorageBackend`'s current (persisted) state. Idempotent --
       * cheap enough to call before every operation that depends on the
       * engine's copy actually reflecting the backend's latest state,
       * rather than tracking a separate "have we seeded yet" flag that
       * could drift after a `mergeManifestEntries()` call reassigns the
       * backend's internal `LWWMap` instance.
       * @returns {Promise<void>}
       */
      async function refreshEngineFromBackend() {
        const snapshot = await cloudStorageBackend.getManifestSnapshot()
        engine.get(docId).crdt = LWWMap.fromJSON(snapshot)
      }

      // Local writes (this peer's own put()/delete() through
      // `cloudStorageBackend`) -- mirror the backend's now-current state
      // into the engine's copy and bump/notify so watch()ing peers receive
      // it. The actual mutation already happened in the backend; this
      // handler's job is purely "make the sync engine aware a change
      // happened", not to decide whether it was authorized (a LOCAL write
      // is authorized by definition -- it's this peer acting as itself).
      const unsubscribeLocal = cloudStorageBackend.onManifestChange(() => {
        refreshEngineFromBackend()
          .then(() => {
            // The mutation is already applied (shared via the snapshot
            // refresh above); this update() call's callback is a no-op --
            // its only purpose is to bump the document's vector clock and
            // fire MeshSyncEngine's subscriber notification, which the
            // watch() broadcast below listens for.
            engine.update(docId, () => {})
          })
          .catch((err) => {
            log('manifest-sync:local-refresh-failed', { bucketId, error: err?.message || String(err) })
          })
      })

      // Broadcast to every watched peer whenever the engine's document
      // changes, whether from a local write (above) or an accepted remote
      // merge (below) -- the latter is what makes multi-hop propagation
      // possible (a peer that merges an authorized remote write and is
      // itself watched by a third peer forwards it onward automatically).
      const unsubscribeBroadcast = engine.subscribe(docId, () => {
        for (const pubKey of watchTargets) {
          syncWith(pubKey).catch((err) => {
            log('manifest-sync:broadcast-failed', { bucketId, to: pubKey, error: err?.message || String(err) })
          })
        }
      })

      // Remote input -- the ONLY path untrusted data enters this service.
      // See the module doc comment for why filtering happens here, on the
      // raw wire payload, strictly before any merge.
      const unsubscribeIncoming = ctx.onIncomingData(envelopeType, (fromPubKey, data) => {
        if (!data || data.docId !== docId || !data.payload || data.payload.type !== 'lww-map') return

        handleIncoming(fromPubKey, data.payload).catch((err) => {
          log('manifest-sync:merge-failed', { bucketId, from: fromPubKey, error: err?.message || String(err) })
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
          // itself send (no multi-hop trust chain exists in this phase to
          // justify accepting a third party's attribution from a
          // non-matching sender). See the module doc comment's "Known,
          // deliberate limitation of this gate" section.
          if (writer !== fromPubKey) {
            log('manifest-sync:reject-attribution-mismatch', { bucketId, key, from: fromPubKey, claimedWriter: writer })
            ctx.emit('manifest-sync:write-rejected', { bucketId, from: fromPubKey, key, reason: 'attribution-mismatch' })
            continue
          }

          const check = ctx.registry.checkAccess(writer, resource, 'write')
          if (!check.allowed) {
            log('manifest-sync:reject-unauthorized-write', {
              bucketId, key, from: fromPubKey, reason: check.reason,
            })
            ctx.emit('manifest-sync:write-rejected', { bucketId, from: fromPubKey, key, reason: 'unauthorized' })
            continue
          }

          sanitizedEntries[key] = regState
        }

        const mergedKeys = Object.keys(sanitizedEntries)
        if (mergedKeys.length === 0) return

        // Make sure the engine's copy reflects the backend's latest
        // persisted state before merging remote input in, so the LWW
        // comparison for each key is against the real current value, not a
        // stale/empty engine-only copy.
        await refreshEngineFromBackend()

        const sanitizedPayload = { ...payload, crdt: { entries: sanitizedEntries } }
        // Keep this service's own engine copy consistent (for correct
        // future re-broadcast/vector-clock bookkeeping) using ONLY the
        // sanitized subset -- never the raw, unfiltered payload.
        engine.merge(docId, sanitizedPayload)

        // Persist into the actual source of truth every get/list/head op
        // reads from.
        await cloudStorageBackend.mergeManifestEntries({ entries: sanitizedEntries })

        ctx.emit('manifest-sync:entry-merged', { bucketId, from: fromPubKey, keys: mergedKeys })
      }

      /**
       * Send this bucket's current manifest state to one peer. Safe to call
       * repeatedly -- CRDT merge on the receiving end is idempotent.
       * @param {string} pubKey
       * @returns {Promise<void>}
       */
      async function syncWith(pubKey) {
        await refreshEngineFromBackend()
        const payload = engine.prepareSyncPayload(docId)
        await ctx.sendTo(pubKey, envelopeType, { docId, payload })
      }

      const api = {
        bucketId,
        docId,
        /** Start broadcasting local/merged manifest changes to `pubKey`. */
        watch(pubKey) {
          watchTargets.add(pubKey)
          ctx.emit('manifest-sync:watching', { bucketId, pubKey })
        },
        /** Stop broadcasting to `pubKey`. */
        unwatch(pubKey) {
          watchTargets.delete(pubKey)
          ctx.emit('manifest-sync:unwatching', { bucketId, pubKey })
        },
        syncWith,
      }

      if (typeof onReady === 'function') onReady(api)

      return {
        api,
        teardown() {
          unsubscribeLocal()
          unsubscribeBroadcast()
          unsubscribeIncoming()
        },
      }
    },
  }
}

export { DEFAULT_ENVELOPE_TYPE }
