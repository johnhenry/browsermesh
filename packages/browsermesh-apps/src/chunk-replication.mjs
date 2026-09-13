/**
 * chunk-replication.mjs -- Phase G of the mesh-native-services plan
 * ("CloudStorage: S3-like object storage"): moves actual ciphertext CHUNK
 * BYTES between peers, closing the gap Phases E/F deliberately left open --
 * Phase F (`manifest-sync.mjs`) replicates the manifest CRDT (the
 * `{chunks: [{cid, iv}], ...}` pointer), and Phase E (`key-distribution.mjs`)
 * delivers the bucket's symmetric key, but neither phase ever moves the
 * chunk-store bytes a manifest entry's `cid`s point at. A peer that receives
 * a manifest entry via Phase F (or is designated a replica but was offline
 * when a `put()` happened) has a pointer to content it does not yet hold.
 * This file is what actually moves those bytes.
 *
 * Built as a `MeshService` (Phase C, `mesh-service.mjs`), following
 * `manifest-sync.mjs`/`key-distribution.mjs` as the closest precedents: wire
 * payloads travel over `ctx.onIncomingData()`/`ctx.sendTo()`, filtered by
 * `envelope.type` (default `'chunk-replication'`), on the SAME dispatch bus
 * every other `MeshService` in this family uses.
 *
 * ---------------------------------------------------------------------------
 * IMPORTANT DEVIATION FROM THE PLAN'S ORIGINAL TEXT (read this first):
 *
 * The plan's own Phase G section says to "investigate peer-files.mjs's
 * existing FileClient/PeerSession-based transfer machinery first for a
 * server-side counterpart to extend". That investigation happened (tracked
 * as github.com/johnhenry/browsermesh issue #84) and found that
 * `peer-files.mjs`/`PeerSession`/`SessionManager` form an ENTIRELY SEPARATE,
 * unwired session architecture that the real `PeerNode` composition root
 * (which every phase A-F of this plan builds on, and every real caller of
 * `createMeshNode()`/`attachService()` uses) never touches -- there is no
 * live bridge from a `PeerNode`'s sessions to a `PeerSession`. Building this
 * phase on top of `PeerSession`/`FileClient` would require first solving
 * issue #84's much larger "bridge two independent session architectures"
 * problem, which is explicitly out of scope for this phase. This file
 * therefore builds BOTH the control-plane and the data-plane directly on
 * `PeerNode.sendTo()`/`onIncomingData()` (via `ctx.sendTo()`/
 * `ctx.onIncomingData()`), the exact same mechanism every other phase in
 * this plan (C through F) already uses -- not a new bespoke transport, and
 * not `PeerSession`.
 *
 * ---------------------------------------------------------------------------
 * TRANSPORT DESIGN: one `sendTo()` call per chunk, not a smaller-frame
 * streaming protocol.
 *
 * `CloudStorageBackend.#encryptAndChunk()` (Phase B) already caps every
 * chunk at 256KB (`TRANSFER_DEFAULTS.chunkSize`, `browsermesh-sync/src/
 * files.mjs`) before it ever reaches the chunk store. Since that upper
 * bound already exists on the write side, this phase's data-plane simply
 * base64-encodes one whole ciphertext chunk into one JSON envelope and
 * sends it with one `ctx.sendTo()` call (`chunk-push` for eager replication,
 * `chunk-fetch-response` for lazy pull) -- no further fragmentation, no
 * reassembly state machine, no flow-control window. This is a deliberate
 * "simplest thing that works" choice, not an oversight:
 *
 *   - Pro: reuses the exact same envelope-type-filtered dispatch every
 *     control message already uses, so there is exactly one transport
 *     concept in this file, not two. A 256KB ciphertext chunk base64-encodes
 *     to ~342KB of JSON payload -- comfortably inside what every transport
 *     this family targets (WebRTC data channels, in-memory loopback) can
 *     move in a single message today.
 *   - Con (throughput tradeoff, stated plainly): base64 inflates the wire
 *     size by ~33%, and JSON.stringify/parse of a several-hundred-KB string
 *     is not free CPU-wise. There is also no windowing/pipelining here --
 *     `replicatePut()` fires all (target x chunk) pushes concurrently via
 *     `Promise.all`, but a single slow/unresponsive peer's chunks are not
 *     retried or resumed mid-flight; a failed push simply never gets acked,
 *     and that peer is absent from `replicatedTo`.
 *   - This is fine as a v1: none of the OTHER phases' contracts (the
 *     durability flag's shape, the manifest CRDT, the GrantLog) depend on
 *     HOW bytes moved. A future revision (raw binary WebRTC datachannel
 *     frames instead of base64-in-JSON, real backpressure/windowing,
 *     resumable transfer) can replace this file's internals without
 *     touching any other phase.
 *
 * ---------------------------------------------------------------------------
 * Wire protocol -- six message kinds sharing one envelope `type` (default
 * `'chunk-replication'`), every message scoped to one `bucketId`:
 *
 *   Eager push (writer -> admin-designated replica), fired from the
 *   `CloudStorageBackend.setReplicationHook()` hook this service installs,
 *   itself invoked by `#opPut()` after the local write is already durable:
 *     `{ type, bucketId, kind: 'chunk-push', requestId, cid, data }`
 *       -- `data` is base64 ciphertext for one chunk.
 *     `{ type, bucketId, kind: 'replicate-ack', requestId, cid }`
 *       -- sent back by the replica once `putChunkRaw()` verifies and
 *          stores the chunk.
 *
 *   Lazy pull / read-repair, step 1 (broadcast "who has X"):
 *     `{ type, bucketId, kind: 'chunk-have-query', queryId, cid }`
 *     `{ type, bucketId, kind: 'chunk-have-response', queryId, cid, has: true }`
 *       -- a peer that does NOT have the chunk stays silent (see "Known
 *          limitation" below) rather than sending a negative response;
 *          the requester's `queryHave()` simply times out if nobody answers.
 *
 *   Lazy pull / read-repair, step 2 (fetch from a peer that answered "have"):
 *     `{ type, bucketId, kind: 'chunk-fetch-request', requestId, cid }`
 *     `{ type, bucketId, kind: 'chunk-fetch-response', requestId, cid, data }`
 *       -- or `{ ..., error: 'unauthorized' | 'not found' }` instead of `data`.
 *
 * None of these messages carry a signature. This matches `manifest-sync.mjs`'s
 * own established precedent (its module doc comment's "Known, deliberate
 * limitation" section): the trust boundary is the connection-authenticated
 * `fromPubKey` `ctx.onIncomingData()` already supplies (established at
 * session/transport level), not an additional per-message signature layer.
 * What IS cryptographically verified is the CHUNK CONTENT itself --
 * `CloudStorageBackend.putChunkRaw()` (Phase G's own addition to that file)
 * recomputes the CID from received bytes and refuses to store anything that
 * doesn't hash to the CID it was sent under, so a chunk's *integrity* is
 * verified independent of who relayed it, exactly the property content-
 * addressing is supposed to buy.
 *
 * ---------------------------------------------------------------------------
 * AUTHORIZATION on every chunk transfer (this phase's core security
 * property, mirroring `manifest-sync.mjs`'s "gate before merge/serve, never
 * after" discipline):
 *
 *   - `chunk-push` (inbound, we are a designated replica receiving pushed
 *     content): the sender must currently hold `s3:<bucketId>:write` --
 *     accepting arbitrary ciphertext from a peer with no write access would
 *     let anyone plant content in this bucket's chunk store under a CID of
 *     their choosing (content-addressing prevents CID *spoofing*, not
 *     unauthorized *origination*).
 *   - `chunk-have-query` / `chunk-fetch-request` (inbound, someone wants to
 *     know about or download a chunk): the sender must currently hold
 *     `s3:<bucketId>:read` -- checked via `registry.checkAccess()` BEFORE
 *     `hasChunkRaw()`/`getChunkRaw()` is ever consulted, so an unauthorized
 *     peer cannot even confirm a chunk exists, let alone download it, even
 *     if it somehow learned a valid CID from elsewhere (e.g. a leaked
 *     manifest snapshot).
 *
 * Known, deliberate limitation (silence-on-"don't have it", stated
 * explicitly rather than left implicit): `chunk-have-query` never sends a
 * negative response -- both "you're unauthorized" and "I don't have it"
 * look identical to the requester (silence). This is intentional: an
 * unauthorized peer probing for a chunk's existence should not be able to
 * distinguish "denied" from "not found" (that distinction itself would leak
 * information about the bucket's replica topology to someone with no access
 * at all). The requester's `queryHave()` is timeout-bounded regardless (see
 * "Never hangs" below), so this costs latency, not correctness.
 *
 * ---------------------------------------------------------------------------
 * DURABILITY CONTRACT (`put()`'s `{durability, replicatedTo}`, the plan's
 * explicit, non-negotiable choice -- restated here because this file is
 * what actually computes it):
 *
 * `replicatePut()` (installed as `CloudStorageBackend`'s replication hook)
 * is invoked by `#opPut()` AFTER the local encrypted write is already
 * durable -- it can never make `put()` fail, and its own timeout
 * (`replicationTimeoutMs`, default 2000ms -- see the constant's own doc
 * comment for the reasoning) bounds how long `put()`'s response is ever
 * delayed. `durability` is `'replicated'` if `replicatedTo` (peers that
 * fully acknowledged EVERY chunk of this write) is non-empty, `'local-only'`
 * otherwise -- including the case where there are zero currently-connected
 * `replica`-scoped peers at all, which returns immediately without waiting
 * out the timeout (nothing to wait for).
 *
 * ---------------------------------------------------------------------------
 * LAZY PULL / READ-REPAIR (`fetchChunk()`/`syncMissingChunks()`, exposed on
 * this service's `api`):
 *
 * `fetchChunk(cid)` is the mechanism this phase provides; deciding WHEN to
 * call it (e.g. a `get()` that finds a manifest entry but a missing chunk)
 * is deliberately left to a higher layer -- the plan's own Phase H
 * ("falls back to a remote peer request... when content isn't held
 * locally") is explicitly where that wiring belongs, not here. This keeps
 * this phase's scope to "provide the mechanism", matching how Phase F
 * provides manifest merge and Phase E provides key delivery without either
 * of those phases deciding when the application calls `get()`.
 *
 * `syncMissingChunks()` is the "reconnecting designated replica catching
 * up" case: it walks the current manifest snapshot, collects every
 * referenced (non-tombstoned) CID, and calls `fetchChunk()` for anything
 * missing locally -- best-effort, never throws (a single unreachable chunk
 * is logged and skipped, not fatal to the rest of the sweep). Like
 * `fetchChunk()` itself, WHEN to call this (on reconnect, on being granted
 * `replica`, on a timer) is a caller/integration decision, not decided here.
 *
 * Both never hang: `queryHave()` and `fetchFrom()` are both timeout-bounded
 * (`haveQueryTimeoutMs` / `fetchTimeoutMs`), and `fetchChunk()` throws a
 * plain `Error` -- never leaves a caller waiting forever -- when either no
 * peer answers "have" at all, or every peer that claimed to have it fails
 * to actually deliver it.
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`, Phase 1 of the mesh-KV-and-
 * observability plan -- see `mesh-service.mjs`'s module doc comment for the
 * full convention this follows). Four curated events, not a mechanical
 * conversion of this file's `onLog` calls:
 *
 *   - `chunk-replication:chunk-replicated` `{bucketId, cids, replicatedTo}`
 *     -- one `replicatePut()` call finished with `durability: 'replicated'`
 *     (at least one designated replica fully acknowledged every pushed cid).
 *   - `chunk-replication:read-repair` `{bucketId, cid, from}` -- a missing
 *     chunk was successfully fetched from a peer via lazy pull
 *     (`fetchChunk()`), the mechanism `syncMissingChunks()`/a `get()` miss
 *     both rely on.
 *   - `chunk-replication:push-rejected` `{bucketId, from, cid}` -- an
 *     inbound `chunk-push` was refused because the sender did not currently
 *     hold `write` on this bucket -- the core security property this file's
 *     "AUTHORIZATION on every chunk transfer" section describes.
 *   - `chunk-replication:fetch-exhausted` `{bucketId, cid}` -- `fetchChunk()`
 *     gave up on a cid because either nobody answered "have" or every
 *     responder failed to actually deliver it.
 *
 * No browser-only imports at module level.
 */

/** Default `envelope.type` used to route chunk-replication payloads on the shared `onIncomingData()` bus. */
const DEFAULT_ENVELOPE_TYPE = 'chunk-replication'

/**
 * How long `replicatePut()` waits for admin-designated replica peers to
 * acknowledge a push before giving up and reporting whatever subset (if
 * any) actually confirmed in time. Chosen as "long enough for a real
 * WebRTC/loopback round trip of a base64'd 256KB-ish chunk under ordinary
 * load, short enough that a `put()` call feels responsive rather than
 * hung" -- this is a starting default, not a tuned constant; callers with
 * different latency/throughput expectations should override it via
 * `createChunkReplicationService({ replicationTimeoutMs })`.
 */
const DEFAULT_REPLICATION_TIMEOUT_MS = 2000

/** How long `queryHave()` waits for the FIRST "have" response (it resolves immediately once one arrives) before giving up on a chunk with no known holder. */
const DEFAULT_HAVE_QUERY_TIMEOUT_MS = 1500

/** How long `fetchFrom()` waits for one specific peer's `chunk-fetch-response` before treating that peer as unreachable and (in `fetchChunk()`) trying the next candidate. */
const DEFAULT_FETCH_TIMEOUT_MS = 3000

// ---------------------------------------------------------------------------
// Base64 helpers -- deliberately duplicated rather than shared, matching
// this family's established convention of small, self-contained per-file
// helpers (see cloud-storage-backend.mjs's / key-distribution.mjs's own
// identical duplication).
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

/** @param {string} bucketId @returns {string} The scope-grammar resource string GrantLog/PeerRegistry expect (`s3:<bucketId>`). */
function resourceFor(bucketId) {
  return `s3:${bucketId}`
}

// ---------------------------------------------------------------------------
// createChunkReplicationService
// ---------------------------------------------------------------------------

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) that
 * replicates one bucket's chunk-store bytes -- both eager push-to-replicas
 * (installed as `cloudStorageBackend`'s replication hook, driving `put()`'s
 * `{durability, replicatedTo}`) and lazy pull/read-repair (`api.fetchChunk()`/
 * `api.syncMissingChunks()`). See this file's module doc comment for the
 * full protocol/authorization/durability writeup.
 *
 * @param {object} opts
 * @param {string} opts.bucketId - Bucket identifier. The ACL resource
 *   checked is `s3:<bucketId>`, matching `manifest-sync.mjs`/`grant-log.mjs`.
 * @param {import('./cloud-storage-backend.mjs').CloudStorageBackend} opts.cloudStorageBackend
 *   Must expose `hasChunkRaw()`/`getChunkRaw()`/`putChunkRaw()`/
 *   `setReplicationHook()`/`getManifestSnapshot()` (Phase G's own additions
 *   plus Phase F's manifest-snapshot surface).
 * @param {string} [opts.envelopeType='chunk-replication']
 * @param {number} [opts.replicationTimeoutMs=2000] - See `DEFAULT_REPLICATION_TIMEOUT_MS`'s doc comment.
 * @param {number} [opts.haveQueryTimeoutMs=1500] - See `DEFAULT_HAVE_QUERY_TIMEOUT_MS`'s doc comment.
 * @param {number} [opts.fetchTimeoutMs=3000] - See `DEFAULT_FETCH_TIMEOUT_MS`'s doc comment.
 * @param {Function} [opts.onLog]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createChunkReplicationService({
  bucketId,
  cloudStorageBackend,
  envelopeType = DEFAULT_ENVELOPE_TYPE,
  replicationTimeoutMs = DEFAULT_REPLICATION_TIMEOUT_MS,
  haveQueryTimeoutMs = DEFAULT_HAVE_QUERY_TIMEOUT_MS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  onLog,
} = {}) {
  if (!bucketId || typeof bucketId !== 'string') {
    throw new Error('createChunkReplicationService: bucketId is required and must be a non-empty string')
  }
  if (!cloudStorageBackend ||
    typeof cloudStorageBackend.hasChunkRaw !== 'function' ||
    typeof cloudStorageBackend.getChunkRaw !== 'function' ||
    typeof cloudStorageBackend.putChunkRaw !== 'function' ||
    typeof cloudStorageBackend.setReplicationHook !== 'function') {
    throw new Error('createChunkReplicationService: cloudStorageBackend is required (a CloudStorageBackend instance with Phase G raw-chunk methods)')
  }

  const resource = resourceFor(bucketId)
  const log = onLog || (() => {})

  return {
    name: `chunk-replication:${bucketId}`,

    attach(peerNode, ctx) {
      let reqSeq = 0
      /** Monotonic-ish unique id for correlating a request/query with its eventual response(s). */
      const nextRequestId = () => `${peerNode?.podId || 'local'}:${Date.now()}:${++reqSeq}`

      /**
       * @type {Map<string, {expectedByTarget: Map<string, Set<string>>,
       *   ackedByTarget: Map<string, Set<string>>, fullyAcked: Set<string>,
       *   resolve: () => void, timer: ReturnType<typeof setTimeout>}>}
       * requestId -> in-flight eager-push tracking, see `replicatePut()`.
       */
      const pendingReplications = new Map()

      /**
       * @type {Map<string, {responders: Set<string>, timer: ReturnType<typeof setTimeout>}>}
       * queryId -> in-flight "who has X" tracking, see `queryHave()`.
       */
      const pendingHaveQueries = new Map()

      /**
       * @type {Map<string, {resolve: (bytes: Uint8Array) => void, reject: (err: Error) => void, timer: ReturnType<typeof setTimeout>}>}
       * requestId -> in-flight chunk-fetch tracking, see `fetchFrom()`.
       */
      const pendingFetches = new Map()

      /** @returns {string[]} Every peer this node's own registry currently considers connected. */
      function connectedPeers() {
        return ctx.registry.listPeers()
          .filter((p) => p && (p.status === 'connected' || p.status === 'authenticated'))
          .map((p) => p.fingerprint)
          .filter(Boolean)
      }

      /** @param {string} action @returns {string[]} Currently-connected peers holding `s3:<bucketId>:<action>`. */
      function connectedPeersWithAccess(action) {
        return connectedPeers().filter((pubKey) => ctx.registry.checkAccess(pubKey, resource, action).allowed)
      }

      // -----------------------------------------------------------------
      // Inbound dispatch
      // -----------------------------------------------------------------
      const handlers = {
        'chunk-push': handleChunkPush,
        'replicate-ack': handleReplicateAck,
        'chunk-have-query': handleHaveQuery,
        'chunk-have-response': handleHaveResponse,
        'chunk-fetch-request': handleFetchRequest,
        'chunk-fetch-response': handleFetchResponse,
      }

      const unsubscribe = ctx.onIncomingData(envelopeType, (fromPubKey, msg) => {
        if (!msg || msg.bucketId !== bucketId || typeof msg.kind !== 'string') return
        const handler = handlers[msg.kind]
        if (!handler) return
        Promise.resolve(handler(fromPubKey, msg)).catch((err) => {
          log('chunk-replication:handler-error', { bucketId, kind: msg.kind, from: fromPubKey, error: err?.message || String(err) })
        })
      })

      // -----------------------------------------------------------------
      // Receiving a pushed chunk (we are a designated replica)
      // -----------------------------------------------------------------

      /** @param {string} fromPubKey @param {object} msg */
      async function handleChunkPush(fromPubKey, msg) {
        if (!ctx.registry.checkAccess(fromPubKey, resource, 'write').allowed) {
          log('chunk-replication:reject-unauthorized-push', { bucketId, from: fromPubKey, cid: msg.cid })
          ctx.emit('chunk-replication:push-rejected', { bucketId, from: fromPubKey, cid: msg.cid })
          return
        }
        if (typeof msg.cid !== 'string' || typeof msg.data !== 'string') return

        try {
          const bytes = fromBase64(msg.data)
          await cloudStorageBackend.putChunkRaw(msg.cid, bytes)
        } catch (err) {
          log('chunk-replication:push-store-failed', { bucketId, from: fromPubKey, cid: msg.cid, error: err?.message || String(err) })
          return
        }

        try {
          await ctx.sendTo(fromPubKey, envelopeType, { bucketId, kind: 'replicate-ack', requestId: msg.requestId, cid: msg.cid })
        } catch (err) {
          log('chunk-replication:ack-send-failed', { bucketId, to: fromPubKey, cid: msg.cid, error: err?.message || String(err) })
        }
      }

      /** @param {string} fromPubKey @param {object} msg */
      function handleReplicateAck(fromPubKey, msg) {
        const pending = pendingReplications.get(msg.requestId)
        if (!pending) return
        const expected = pending.expectedByTarget.get(fromPubKey)
        const acked = pending.ackedByTarget.get(fromPubKey)
        if (!expected || !acked || typeof msg.cid !== 'string') return

        acked.add(msg.cid)
        if (acked.size < expected.size) return

        pending.fullyAcked.add(fromPubKey)
        if (pending.fullyAcked.size >= pending.expectedByTarget.size) {
          clearTimeout(pending.timer)
          pendingReplications.delete(msg.requestId)
          pending.resolve()
        }
      }

      // -----------------------------------------------------------------
      // "who has cid X" query/response (lazy pull, step 1)
      // -----------------------------------------------------------------

      /** @param {string} fromPubKey @param {object} msg */
      async function handleHaveQuery(fromPubKey, msg) {
        if (typeof msg.cid !== 'string' || typeof msg.queryId !== 'string') return
        // Unauthorized peers get silence, identical to "don't have it" --
        // see module doc comment's "Known, deliberate limitation" section.
        if (!ctx.registry.checkAccess(fromPubKey, resource, 'read').allowed) return

        const has = await cloudStorageBackend.hasChunkRaw(msg.cid)
        if (!has) return

        await ctx.sendTo(fromPubKey, envelopeType, { bucketId, kind: 'chunk-have-response', queryId: msg.queryId, cid: msg.cid, has: true }).catch((err) => {
          log('chunk-replication:have-response-send-failed', { bucketId, to: fromPubKey, cid: msg.cid, error: err?.message || String(err) })
        })
      }

      /**
       * @param {string} fromPubKey @param {object} msg
       * The FIRST "have" response resolves `queryHave()`'s wait immediately
       * (see that function's doc comment for why: a broadcast-and-first-
       * response design, not "collect every answer within the window") --
       * `pendingHaveQueries.get()` returning `undefined` on every response
       * after the first is what makes this a no-op rather than a double-
       * resolve.
       */
      function handleHaveResponse(fromPubKey, msg) {
        const pending = pendingHaveQueries.get(msg.queryId)
        if (!pending || !msg.has) return
        pending.responders.add(fromPubKey)
        pending.resolveEarly()
      }

      // -----------------------------------------------------------------
      // Chunk fetch request/response (lazy pull, step 2)
      // -----------------------------------------------------------------

      /** @param {string} fromPubKey @param {object} msg */
      async function handleFetchRequest(fromPubKey, msg) {
        if (typeof msg.cid !== 'string' || typeof msg.requestId !== 'string') return

        if (!ctx.registry.checkAccess(fromPubKey, resource, 'read').allowed) {
          log('chunk-replication:reject-unauthorized-fetch', { bucketId, from: fromPubKey, cid: msg.cid })
          await ctx.sendTo(fromPubKey, envelopeType, { bucketId, kind: 'chunk-fetch-response', requestId: msg.requestId, cid: msg.cid, error: 'unauthorized' }).catch(() => {})
          return
        }

        const bytes = await cloudStorageBackend.getChunkRaw(msg.cid)
        if (!bytes) {
          await ctx.sendTo(fromPubKey, envelopeType, { bucketId, kind: 'chunk-fetch-response', requestId: msg.requestId, cid: msg.cid, error: 'not found' }).catch(() => {})
          return
        }

        await ctx.sendTo(fromPubKey, envelopeType, { bucketId, kind: 'chunk-fetch-response', requestId: msg.requestId, cid: msg.cid, data: toBase64(bytes) }).catch((err) => {
          log('chunk-replication:fetch-response-send-failed', { bucketId, to: fromPubKey, cid: msg.cid, error: err?.message || String(err) })
        })
      }

      /** @param {string} fromPubKey @param {object} msg */
      function handleFetchResponse(fromPubKey, msg) {
        const pending = pendingFetches.get(msg.requestId)
        if (!pending) return
        pendingFetches.delete(msg.requestId)
        clearTimeout(pending.timer)

        if (msg.error) {
          pending.reject(new Error(`chunk-replication: fetch of ${msg.cid} from ${fromPubKey} failed: ${msg.error}`))
          return
        }
        if (typeof msg.data !== 'string') {
          pending.reject(new Error(`chunk-replication: malformed fetch response from ${fromPubKey}`))
          return
        }
        pending.resolve(fromBase64(msg.data))
      }

      // -----------------------------------------------------------------
      // Eager push -- the replication hook CloudStorageBackend.put() awaits.
      // -----------------------------------------------------------------

      /**
       * @param {{key: string, entry: {chunks: Array<{cid: string, iv: string}>}}} info
       * @returns {Promise<{durability: 'local-only'|'replicated', replicatedTo: string[]}>}
       */
      async function replicatePut({ entry }) {
        const targets = connectedPeersWithAccess('replica')
        const cids = [...new Set((entry?.chunks || []).map((c) => c?.cid).filter(Boolean))]
        if (targets.length === 0 || cids.length === 0) {
          return { durability: 'local-only', replicatedTo: [] }
        }

        const chunkBytesByCid = new Map()
        for (const cid of cids) {
          const bytes = await cloudStorageBackend.getChunkRaw(cid)
          if (bytes) chunkBytesByCid.set(cid, bytes)
        }

        const requestId = nextRequestId()
        const expectedByTarget = new Map(targets.map((t) => [t, new Set(cids)]))
        const ackedByTarget = new Map(targets.map((t) => [t, new Set()]))
        const fullyAcked = new Set()

        const donePromise = new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingReplications.delete(requestId)
            resolve()
          }, replicationTimeoutMs)
          pendingReplications.set(requestId, { expectedByTarget, ackedByTarget, fullyAcked, resolve, timer })
        })

        const sends = []
        for (const target of targets) {
          for (const cid of cids) {
            const bytes = chunkBytesByCid.get(cid)
            if (!bytes) continue // we don't hold this chunk ourselves -- nothing to push
            sends.push(
              ctx.sendTo(target, envelopeType, { bucketId, kind: 'chunk-push', requestId, cid, data: toBase64(bytes) }).catch((err) => {
                log('chunk-replication:push-send-failed', { bucketId, to: target, cid, error: err?.message || String(err) })
              }),
            )
          }
        }
        await Promise.all(sends)
        await donePromise

        const replicatedTo = [...fullyAcked]
        if (replicatedTo.length > 0) {
          ctx.emit('chunk-replication:chunk-replicated', { bucketId, cids, replicatedTo })
        }

        return {
          durability: replicatedTo.length > 0 ? 'replicated' : 'local-only',
          replicatedTo,
        }
      }

      cloudStorageBackend.setReplicationHook(replicatePut)

      // -----------------------------------------------------------------
      // Lazy pull / read-repair
      // -----------------------------------------------------------------

      /**
       * Broadcast "who has cid X" to every currently-connected peer.
       * Broadcast-and-first-response, per the module doc comment's stated
       * design ("doesn't need to be sophisticated"): resolves as soon as
       * the FIRST "have" response arrives (typically one network round
       * trip, not the full timeout window) -- `haveQueryTimeoutMs` is only
       * the upper bound for the "nobody has it" case, where nothing ever
       * arrives to resolve early.
       * @param {string} cid
       * @returns {Promise<string[]>} pubKeys that responded "have" by the
       *   time this resolves -- one element in the common case (the first
       *   responder), possibly more than one if several answers land in
       *   the same event-loop turn, empty if nobody answered in time.
       */
      async function queryHave(cid) {
        // Broadcast to every currently-connected peer, not just ones this
        // requester's own registry already believes hold a grant on this
        // bucket -- requiring the requester to already know who else is
        // authorized would be a real-world chicken-and-egg problem (that
        // knowledge only exists once the GrantLog has fully propagated,
        // which is exactly the kind of ordering this file shouldn't
        // depend on). Safety is unaffected either way: the actual gate is
        // `handleHaveQuery()`'s own `checkAccess()` on the RESPONDER's
        // registry, not any filtering done here -- an unrelated/
        // unauthorized peer that gets asked and cannot answer just stays
        // silent (see the module doc comment's "Known, deliberate
        // limitation" section).
        const candidates = connectedPeers()
        if (candidates.length === 0) return []

        const queryId = nextRequestId()
        const responders = new Set()

        const donePromise = new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingHaveQueries.delete(queryId)
            resolve()
          }, haveQueryTimeoutMs)
          pendingHaveQueries.set(queryId, {
            responders,
            timer,
            resolveEarly() {
              clearTimeout(timer)
              pendingHaveQueries.delete(queryId)
              resolve()
            },
          })
        })

        await Promise.all(candidates.map((pubKey) =>
          ctx.sendTo(pubKey, envelopeType, { bucketId, kind: 'chunk-have-query', queryId, cid }).catch(() => {}),
        ))
        await donePromise
        return [...responders]
      }

      /**
       * Request one specific chunk from one specific peer. Timeout-bounded;
       * never hangs.
       * @param {string} pubKey
       * @param {string} cid
       * @returns {Promise<Uint8Array>}
       */
      async function fetchFrom(pubKey, cid) {
        const requestId = nextRequestId()
        const promise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingFetches.delete(requestId)
            reject(new Error(`chunk-replication: fetch of ${cid} from ${pubKey} timed out after ${fetchTimeoutMs}ms`))
          }, fetchTimeoutMs)
          pendingFetches.set(requestId, { resolve, reject, timer })
        })

        try {
          await ctx.sendTo(pubKey, envelopeType, { bucketId, kind: 'chunk-fetch-request', requestId, cid })
        } catch (err) {
          const pending = pendingFetches.get(requestId)
          if (pending) {
            clearTimeout(pending.timer)
            pendingFetches.delete(requestId)
          }
          throw err
        }

        return promise
      }

      /**
       * Fetch and locally persist (via `putChunkRaw()`, which re-verifies
       * the CID) a chunk this peer doesn't hold, from whichever currently-
       * connected, authorized peer answers "have" and successfully delivers
       * it. Resolves immediately (no network round trip) if this peer
       * already holds the chunk. Throws a plain `Error` -- never hangs --
       * if nobody currently connected has it, or every responder fails to
       * actually deliver it.
       * @param {string} cid
       * @returns {Promise<Uint8Array>}
       */
      async function fetchChunk(cid) {
        const already = await cloudStorageBackend.getChunkRaw(cid)
        if (already) return already

        const responders = await queryHave(cid)
        if (responders.length === 0) {
          ctx.emit('chunk-replication:fetch-exhausted', { bucketId, cid })
          throw new Error(`chunk-replication: no connected peer has chunk ${cid} for bucket ${bucketId}`)
        }

        let lastErr = null
        for (const pubKey of responders) {
          try {
            const bytes = await fetchFrom(pubKey, cid)
            await cloudStorageBackend.putChunkRaw(cid, bytes)
            ctx.emit('chunk-replication:read-repair', { bucketId, cid, from: pubKey })
            return bytes
          } catch (err) {
            lastErr = err
            log('chunk-replication:fetch-attempt-failed', { bucketId, cid, from: pubKey, error: err?.message || String(err) })
          }
        }
        ctx.emit('chunk-replication:fetch-exhausted', { bucketId, cid })
        throw lastErr || new Error(`chunk-replication: failed to fetch chunk ${cid} from any responder`)
      }

      /**
       * Walk the current manifest, fetching (via `fetchChunk()`) any
       * referenced, non-tombstoned chunk this peer doesn't hold locally yet.
       * Best-effort catch-up for a reconnecting designated replica, or any
       * authorized reader whose manifest sync arrived before the content
       * did -- never throws; a single unreachable/missing chunk is logged
       * and skipped rather than aborting the rest of the sweep.
       * @returns {Promise<{checked: number, fetched: number, failed: number}>}
       */
      async function syncMissingChunks() {
        const snapshot = await cloudStorageBackend.getManifestSnapshot()
        const entries = snapshot?.entries || {}
        const cids = new Set()
        for (const reg of Object.values(entries)) {
          if (!reg || reg.tombstone) continue
          for (const c of reg.value?.chunks || []) {
            if (c?.cid) cids.add(c.cid)
          }
        }

        let fetched = 0
        let failed = 0
        for (const cid of cids) {
          const has = await cloudStorageBackend.hasChunkRaw(cid)
          if (has) continue
          try {
            await fetchChunk(cid)
            fetched += 1
          } catch (err) {
            failed += 1
            log('chunk-replication:sync-missing-failed', { bucketId, cid, error: err?.message || String(err) })
          }
        }
        return { checked: cids.size, fetched, failed }
      }

      const api = {
        bucketId,
        resource,
        fetchChunk,
        syncMissingChunks,
        /** @returns {string[]} Currently-connected peers holding the `replica` scope, per this peer's own registry -- exposed for tests/introspection. */
        listReplicaPeers: () => connectedPeersWithAccess('replica'),
      }

      return {
        api,
        teardown() {
          unsubscribe()
          cloudStorageBackend.setReplicationHook(null)

          for (const p of pendingReplications.values()) clearTimeout(p.timer)
          pendingReplications.clear()
          for (const p of pendingHaveQueries.values()) clearTimeout(p.timer)
          pendingHaveQueries.clear()
          for (const p of pendingFetches.values()) clearTimeout(p.timer)
          pendingFetches.clear()
        },
      }
    },
  }
}

export {
  DEFAULT_ENVELOPE_TYPE,
  DEFAULT_REPLICATION_TIMEOUT_MS,
  DEFAULT_HAVE_QUERY_TIMEOUT_MS,
  DEFAULT_FETCH_TIMEOUT_MS,
}
