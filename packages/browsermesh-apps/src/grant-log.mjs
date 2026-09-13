/**
 * grant-log.mjs -- Phase D of the CloudStorage plan: a replicated, signed
 * append-log ("GrantLog") that solves the gap the plan's Context section
 * names explicitly -- `PeerRegistry.grantCapabilities()` is entirely local,
 * it never transmits anything, so a *replicated* resource (a CloudStorage
 * bucket, or any future mesh-native service) needs authorization itself
 * propagated across peers, not just decided once by one peer.
 *
 * Built as a `MeshService` consumer (Phase C, `mesh-service.mjs`): the log
 * travels as small envelopes over `ctx.onIncomingData()`/`ctx.sendTo()`,
 * matching `mesh-sync.mjs`/`mesh-relay-host.mjs`'s established pattern
 * rather than hand-rolling raw `PeerNode` dispatch.
 *
 * ---------------------------------------------------------------------------
 * Record shape (the plan's exact shape, plus one addition -- see below):
 *
 *   {
 *     pubKey: string,             // grantee -- who this record affects
 *     scope: string,              // full 3-segment scope, e.g. 's3:my-bucket:read'
 *     action: 'grant' | 'revoke', // what this record does to `scope` for `pubKey`
 *     at: number,                 // ms epoch, caller-supplied (see Known limitations)
 *     signedBy: string,           // admin's podId who authorized this record
 *     signedByPubKeyBytes: string,// base64url raw Ed25519 public key of `signedBy`
 *     signature: string,          // base64url Ed25519 signature over the canonical
 *                                 // JSON of {pubKey, scope, action, at, signedBy}
 *   }
 *
 * `signedByPubKeyBytes` is the one addition beyond the plan's literal
 * `{pubKey, scope, action, at, signedBy}` shape. Reasoning: a replicated,
 * peer-to-peer log has no central directory a receiving peer could consult
 * to look up "the real public key for podId X" -- unlike `AuditChain.verify()`
 * (`audit.mjs`), which takes a `getPublicKey(podId)` *resolver* callback the
 * caller must already have a way to satisfy. GrantLog records instead carry
 * their own signer's public key bytes, and every receiving peer independently
 * re-derives `signedBy` from those bytes (`base64url(SHA-256(rawBytes))`,
 * exactly `derivePodId()`'s own definition in
 * `browsermesh-primitives/src/identity.mjs`) before trusting the embedded
 * key -- so a record is self-verifying: nobody can attach someone else's
 * claimed identity to a key they don't hold, and no out-of-band key exchange
 * is required for Phase D to work standalone (ahead of Phase E's dedicated
 * key-distribution channel, which solves an unrelated problem: distributing
 * the bucket's *symmetric* AES key, not identity verification).
 *
 * ---------------------------------------------------------------------------
 * Replica designation: implemented as a sixth scope action, `replica`
 * (`s3:<bucketId>:replica`), grant/revoke exactly like `read`/`write`/
 * `delete`/`list`/`admin`. This was the plan's "either is fine" choice
 * between a fifth action-scope and a distinct record type; a fifth
 * action-scope was chosen because it requires zero extra record-type
 * branching anywhere in this file (construction, verification, replay all
 * stay ignorant of what a "capability action" string actually means to the
 * consumer), which is also what keeps this module resource/service-agnostic
 * (the plan's "keep it generic... this pattern may get reused" ask) --
 * CloudStorage's `s3:<bucketId>` resource and its 6 actions are just this
 * module's first caller-supplied values, not anything hardcoded here.
 *
 * ---------------------------------------------------------------------------
 * Authorization-chain replay algorithm (point 3 of the plan's "Testing"
 * section, and the "who is even allowed to grant" question):
 *
 * The underlying `ORSet` (`browsermesh-primitives/src/crdt.mjs`) is used
 * PURELY ADDITIVELY -- `.remove()` is never called. A "revoke" is not a
 * CRDT-level removal of a previous "grant" element; it is a new, independently
 * signed record with `action: 'revoke'`. This matches the plan's own framing
 * ("signed append-log") literally: nothing is ever retracted from the log,
 * only appended to it. What a revoke actually does is handled entirely in
 * the *interpretation* layer (`#computeEffective()` below), not in the CRDT
 * layer -- keeping "is this signature/identity-binding valid" (a CRDT-merge
 * admission gate) cleanly separate from "does this signer currently have the
 * authority to do this" (a replay-time interpretation question that depends
 * on the rest of the log).
 *
 * `#computeEffective()` walks every signature-valid, resource-matching
 * record in one deterministic total order -- ascending `at`, ties broken
 * `grant` before `revoke` (so a same-timestamp revoke always lands after,
 * and therefore wins over, a same-timestamp grant of the same scope -- see
 * "Concurrent grant+revoke" below), remaining ties broken by the record's
 * own signature bytes (arbitrary but stable, guaranteeing every peer that
 * merged the same set of records computes the identical order) -- while
 * maintaining a running `adminSet`:
 *
 *   - A record whose `scope` is this resource's admin scope
 *     (`<resource>:admin`), `action: 'grant'`, and `signedBy === pubKey`
 *     (self-signed) is treated as a BOOTSTRAP record -- applied
 *     unconditionally -- ONLY while `adminSet` is still empty. This is the
 *     one and only door into the admin set from nothing; see "Admin
 *     bootstrapping" below for why this is safe against forgery.
 *   - Every other record is applied (i.e. affects `adminSet` if it's an
 *     admin-scope record, or the per-pubKey/per-scope grant state
 *     otherwise) if and only if `signedBy` is ALREADY in `adminSet` at the
 *     point in the deterministic order where this record is being
 *     processed. A record whose `signedBy` never held admin authority (at
 *     the time its position in the order is reached) never affects
 *     anything -- exactly the "a non-admin claiming to grant is rejected"
 *     requirement, enforced at replay time rather than at merge time (a
 *     signature-valid-but-unauthorized record IS still accepted into the
 *     underlying `ORSet` -- the log records "this really was sent by this
 *     real peer" -- it just never becomes an effective grant, and
 *     therefore never reaches `PeerRegistry`).
 *
 * For each (pubKey, scope) pair, the LAST record reached in this order
 * (that was actually authorized) determines the current effective action
 * (`grant` or `revoke`) -- a simple per-key last-write-wins, deliberately
 * mirroring `LWWMap`'s own already-accepted-as-a-known-limitation semantics
 * (see the plan's Design decisions section) rather than inventing a
 * different conflict model for this log.
 *
 * Known limitation (documented, not silently assumed correct, matching the
 * family's existing convention for `LWWMap`): `at` is caller-supplied, not
 * server-clock-arbitrated. A peer with a fast clock can make its own
 * grant/revoke "win" a race it was not actually causally after. This is the
 * same class of limitation already accepted for `LWWMap` in this plan's
 * Design decisions section, applied consistently here rather than solved
 * differently in one CRDT and not the other.
 *
 * Known limitation (revocation is not retroactive): once a record has been
 * applied while its `signedBy` held admin authority, revoking that admin's
 * authority *later* (in the deterministic order) does not retroactively
 * invalidate grants they already issued -- each record's authorization is
 * locked in using the adminSet state at the moment it is processed, not
 * recomputed after the fact. Revoking what a since-demoted admin granted
 * requires an explicit revoke record for those specific scopes. This
 * mirrors `PeerRegistry`'s own capability-token model, where a granted
 * token lives until it is itself explicitly revoked.
 *
 * ---------------------------------------------------------------------------
 * Concurrent grant+revoke of the same scope: "sensible" is defined here as
 * plain last-write-wins by `at` (see above), with `revoke` winning a same-
 * `at` tie against `grant`. A later grant with a strictly greater `at` DOES
 * re-authorize after a revoke (revoke is not a permanent, one-way tombstone
 * the way `PeerRegistry`'s own capability tokens are for a single peer's
 * local grants) -- because a replicated, multi-admin resource legitimately
 * needs "un-revoke", e.g. an admin overturning another admin's revoke.
 * Whichever authorized record has the latest `at` for that exact
 * (pubKey, scope) pair simply wins, symmetrically in both directions.
 *
 * ---------------------------------------------------------------------------
 * Admin bootstrapping: the peer that locally creates a bucket (or, more
 * generally, this module's caller for any resource) calls
 * `GrantLog.bootstrapAdmin()`, which self-signs the resource's admin scope
 * to itself (`signedBy === pubKey === `the local identity`). This is the
 * only record type the replay algorithm ever admits with no pre-existing
 * admin, and only takes effect while `adminSet` is still empty at its
 * position in the deterministic order -- so a forged self-signed
 * admin-grant produced by an attacker AFTER a real bootstrap record already
 * exists earlier in the merged log's order is correctly rejected (adminSet
 * is non-empty by the time the forged record is reached, and the attacker's
 * `signedBy` is not in it). The one sharp edge, stated plainly rather than
 * silently assumed away: if two peers each believe they are the first to
 * create the *same* resource id, whichever self-signed bootstrap record
 * sorts first in the deterministic order (lowest `at`, then the tiebreakers
 * above) wins sole admin status -- exactly the same "earliest write wins"
 * exposure the plan already accepts for `LWWMap`, not a new one introduced
 * here. Callers minting resource ids should make collisions practically
 * impossible (e.g. include a random/content-addressed component), the same
 * way this family already expects of any globally-shared identifier.
 *
 * ---------------------------------------------------------------------------
 * Replay-diffing strategy into `PeerRegistry` (point 3's "real correctness
 * question", not a style preference): every time the merged log changes
 * (a local `grant()`/`revoke()`/`bootstrapAdmin()`, or a remote
 * `mergeRemote()`), `#computeEffective()` is recomputed and diffed against
 * the PREVIOUS effective snapshot, per pubKey, per scope. Only scopes that
 * newly appear are passed to `registry.grantCapabilities()`; only scopes
 * that disappeared are passed to `registry.revokeCapabilities()`; scopes
 * whose state didn't change are never touched. This was a deliberate
 * choice over the simpler-looking "revoke everything this pubKey ever had,
 * then re-grant the fresh full set on every merge": that naive approach
 * creates a real window (however small) where a concurrent `checkAccess()`
 * call from another part of the running process observes the
 * momentarily-fully-revoked state between the blind revoke and the
 * re-grant -- a legitimate in-flight read/write could be denied for no
 * real reason. Diffing means a scope that was granted before and still is
 * after a merge is never revoked even transiently.
 *
 * ---------------------------------------------------------------------------
 * Change notification (added for Phase E, `key-distribution.mjs`): an
 * optional `onGrantChange` constructor callback, invoked once per affected
 * `pubKey` at the end of every `#replay()` (local mutation or `mergeRemote()`
 * alike -- the same single place the existing `registry.grantCapabilities()`/
 * `revokeCapabilities()` diffing already runs), with `{pubKey, before, after,
 * added, removed}` (`before`/`after` are the pre/post `Set<string>` of
 * effective scopes for that `pubKey` on this resource; `added`/`removed` are
 * arrays of the scopes that actually changed). This reuses the diff
 * `#replay()` already computes for `PeerRegistry` -- no extra pass over the
 * log. Phase E's key-distribution service uses `before.size === 0 &&
 * after.size > 0` to detect "this pubKey just gained SOME capability on this
 * resource" (equivalent to "gained any of read/write/delete/list/admin/
 * replica" for an s3 resource, since those are the only six actions ever
 * used -- this module still doesn't hardcode that list, staying resource-
 * agnostic per its own design goal above). Follows this file's own established
 * convention for optional constructor-injected callbacks (`onLog`) rather than
 * introducing a new event-emitter dependency.
 *
 * No browser-only imports at module level.
 */

import { ORSet, encodeBase64url, decodeBase64url } from '@johnhenry/browsermesh-primitives'

/** Default `envelope.type` used to route GrantLog payloads on the shared `onIncomingData()` bus. */
const DEFAULT_ENVELOPE_TYPE = 'grant-log'

/** The action-scope segment reserved for admin authority (`<resource>:admin`). */
const ADMIN_ACTION = 'admin'

// ---------------------------------------------------------------------------
// Canonical JSON (mirrors audit.mjs's canonicalJSON: sorted keys, so the
// same logical record always signs/hashes to the same bytes regardless of
// property insertion order).
// ---------------------------------------------------------------------------

/**
 * @param {object} obj
 * @returns {string}
 */
function canonicalJSON(obj) {
  return JSON.stringify(obj, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted = {}
      for (const k of Object.keys(value).sort()) sorted[k] = value[k]
      return sorted
    }
    return value
  })
}

/**
 * The exact fields that are signed -- everything in a record EXCEPT
 * `signedByPubKeyBytes` and `signature` themselves.
 *
 * @param {{pubKey: string, scope: string, action: string, at: number, signedBy: string}} fields
 * @returns {string}
 */
function signedPayloadOf(fields) {
  return canonicalJSON({
    pubKey: fields.pubKey,
    scope: fields.scope,
    action: fields.action,
    at: fields.at,
    signedBy: fields.signedBy,
  })
}

/**
 * base64url(SHA-256(rawPublicKeyBytes)) -- the exact definition of
 * `derivePodId()` in `browsermesh-primitives/src/identity.mjs`, duplicated
 * here (one digest call) rather than imported, because that function takes
 * a `CryptoKey` and re-exports the raw bytes internally; a receiving peer
 * here already has the raw bytes (decoded from the record itself) and
 * importing them into a `CryptoKey` purely to re-export them back out would
 * be wasted work for the identical result.
 *
 * @param {Uint8Array} rawPublicKeyBytes
 * @returns {Promise<string>}
 */
async function podIdFromRawPublicKey(rawPublicKeyBytes) {
  const hash = await crypto.subtle.digest('SHA-256', rawPublicKeyBytes)
  return encodeBase64url(new Uint8Array(hash))
}

/** @param {string} resource @param {string} action @returns {string} */
function scopeFor(resource, action) {
  return `${resource}:${action}`
}

// ---------------------------------------------------------------------------
// GrantLog
// ---------------------------------------------------------------------------

/**
 * A signed, append-only, replicated grant/revoke log for one `resource`
 * string (e.g. `s3:my-bucket`). Storage-agnostic and resource-agnostic by
 * design -- it deals only in pubKey strings, scope strings, and signed
 * records, never in the actual data a resource's capabilities gate access
 * to.
 */
export class GrantLog {
  /** @type {string} */
  #resource

  /** @type {string} */
  #localPodId

  /** @type {import('@johnhenry/browsermesh-core').IdentityWallet} Duck-typed:
   * only `.sign(podId, data)`, `.verify(pubKeyBytes, data, sig)`,
   * `.getPublicKeyBytes(podId)` are used (the real `IdentityWallet`'s
   * confirmed API, see identity-wallet.mjs / identity.mjs). */
  #wallet

  /** @type {import('./peer-registry.mjs').PeerRegistry} */
  #registry

  /** @type {Function} */
  #onLog

  /** @type {Function|null} See the module doc comment's "Change notification" section. */
  #onGrantChange

  /** @type {ORSet} Element type: canonical-JSON-stringified signed records. */
  #orSet = new ORSet()

  /** @type {{admins: Set<string>, grants: Map<string, Set<string>>}} Last replayed snapshot. */
  #effective = { admins: new Set(), grants: new Map() }

  /**
   * The largest `at` this instance has ever issued locally. `Date.now()`'s
   * millisecond resolution means two records built back-to-back from the
   * SAME instance (e.g. `bootstrapAdmin()` immediately followed by
   * `grant()`) can otherwise land on an identical `at`, and the
   * deterministic tie-break (see `#compareRecords`) does not know these two
   * came from a single, obviously-ordered call sequence -- it would resolve
   * the tie the same arbitrary way it resolves a genuine cross-peer
   * collision. Monotonically bumping `at` past whatever this instance has
   * already issued preserves real local happens-before order for the common
   * case (one admin issuing several records in a row) while leaving the
   * documented, arbitrary-but-deterministic tie-break exactly as the only
   * resolution for genuinely concurrent records from two different
   * `GrantLog` instances (which can't see each other's clocks). This is a
   * local-clock discipline, not a wire-format change -- `at` is still a
   * plain number in every record.
   * @type {number}
   */
  #lastIssuedAt = 0

  /**
   * @param {object} opts
   * @param {string} opts.resource - e.g. `s3:my-bucket`. Every scope this
   *   log will ever grant/revoke/authorize is `${resource}:${action}`.
   * @param {string} opts.localPodId - This peer's own identity, used as the
   *   CRDT node id for `ORSet.add()` and as the default admin identity for
   *   `grant()`/`revoke()`/`bootstrapAdmin()` when no `signedByPodId` is given.
   * @param {import('@johnhenry/browsermesh-core').IdentityWallet} opts.wallet
   *   Real signing/verification -- see module doc comment.
   * @param {import('./peer-registry.mjs').PeerRegistry} opts.registry -
   *   Replayed into via its existing, completely unmodified
   *   `grantCapabilities()`/`revokeCapabilities()`.
   * @param {Function} [opts.onLog]
   * @param {(change: {pubKey: string, before: Set<string>, after: Set<string>,
   *   added: string[], removed: string[]}) => void} [opts.onGrantChange] - See
   *   the module doc comment's "Change notification" section.
   */
  constructor({ resource, localPodId, wallet, registry, onLog, onGrantChange } = {}) {
    if (!resource || typeof resource !== 'string') {
      throw new Error('GrantLog: resource is required and must be a non-empty string')
    }
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('GrantLog: localPodId is required and must be a non-empty string')
    }
    if (!wallet || typeof wallet.sign !== 'function' || typeof wallet.verify !== 'function' ||
      typeof wallet.getPublicKeyBytes !== 'function') {
      throw new Error('GrantLog: wallet is required and must provide sign()/verify()/getPublicKeyBytes()')
    }
    if (!registry || typeof registry.grantCapabilities !== 'function' || typeof registry.revokeCapabilities !== 'function') {
      throw new Error('GrantLog: registry is required and must provide grantCapabilities()/revokeCapabilities()')
    }

    this.#resource = resource
    this.#localPodId = localPodId
    this.#wallet = wallet
    this.#registry = registry
    this.#onLog = onLog || (() => {})
    this.#onGrantChange = typeof onGrantChange === 'function' ? onGrantChange : null
  }

  /** @returns {string} */
  get resource() {
    return this.#resource
  }

  /** @returns {string} The reserved admin scope for this resource (`<resource>:admin`). */
  get adminScope() {
    return scopeFor(this.#resource, ADMIN_ACTION)
  }

  // -----------------------------------------------------------------------
  // Record construction (local mutation)
  // -----------------------------------------------------------------------

  /**
   * @param {{pubKey: string, scope: string, action: 'grant'|'revoke', signedByPodId: string}} fields
   * @returns {Promise<object>} A fully signed record.
   */
  async #buildRecord({ pubKey, scope, action, signedByPodId }) {
    const signedByPubKeyBytes = await this.#wallet.getPublicKeyBytes(signedByPodId)
    const at = Math.max(Date.now(), this.#lastIssuedAt + 1)
    this.#lastIssuedAt = at
    const unsigned = { pubKey, scope, action, at, signedBy: signedByPodId }
    const payload = new TextEncoder().encode(signedPayloadOf(unsigned))
    const signature = await this.#wallet.sign(signedByPodId, payload)
    return {
      ...unsigned,
      signedByPubKeyBytes: encodeBase64url(signedByPubKeyBytes),
      signature: encodeBase64url(signature),
    }
  }

  /** @param {object} record */
  #addLocal(record) {
    this.#orSet.add(canonicalJSON(record), this.#localPodId)
  }

  /**
   * Throws unless `adminPodId` is currently an authorized admin for this
   * resource (per the last computed replay), UNLESS `allowBootstrap` is set
   * and there is no admin at all yet (the only case `bootstrapAdmin()` uses).
   *
   * @param {string} adminPodId
   * @param {boolean} allowBootstrap
   */
  #assertCanAdminister(adminPodId, allowBootstrap) {
    if (allowBootstrap && this.#effective.admins.size === 0) return
    if (!this.#effective.admins.has(adminPodId)) {
      throw new Error(
        `GrantLog: '${adminPodId}' is not a current admin of '${this.#resource}' -- ` +
        'a record it signs would be rejected by every peer\'s replay anyway',
      )
    }
  }

  /**
   * Grant one or more capability actions on this resource to `pubKey`,
   * signed by `signedByPodId` (defaults to this log's `localPodId`).
   * `signedByPodId` must be an identity `wallet` can sign with (i.e. a
   * local identity) AND a currently authorized admin -- see
   * `#assertCanAdminister()`.
   *
   * @param {string} pubKey - Grantee.
   * @param {string|string[]} actions - Bare capability suffixes, e.g. 'read'
   *   or ['read', 'write']. Full scope = `${resource}:${action}`.
   * @param {object} [opts]
   * @param {string} [opts.signedByPodId]
   * @returns {Promise<void>}
   */
  async grant(pubKey, actions, opts = {}) {
    await this.#mutate(pubKey, actions, 'grant', opts)
  }

  /**
   * Revoke one or more capability actions on this resource from `pubKey`.
   * See `grant()` for parameters.
   *
   * @param {string} pubKey
   * @param {string|string[]} actions
   * @param {object} [opts]
   * @returns {Promise<void>}
   */
  async revoke(pubKey, actions, opts = {}) {
    await this.#mutate(pubKey, actions, 'revoke', opts)
  }

  /**
   * @param {string} pubKey
   * @param {string|string[]} actions
   * @param {'grant'|'revoke'} action
   * @param {object} opts
   */
  async #mutate(pubKey, actions, action, { signedByPodId } = {}) {
    if (!pubKey || typeof pubKey !== 'string') {
      throw new Error('GrantLog: pubKey is required and must be a non-empty string')
    }
    const list = Array.isArray(actions) ? actions : [actions]
    if (list.length === 0) throw new Error('GrantLog: at least one action is required')

    const adminPodId = signedByPodId || this.#localPodId
    this.#assertCanAdminister(adminPodId, false)

    for (const capAction of list) {
      const scope = scopeFor(this.#resource, capAction)
      const record = await this.#buildRecord({ pubKey, scope, action, signedByPodId: adminPodId })
      this.#addLocal(record)
    }
    await this.#replay()
  }

  /**
   * Seed this resource's admin scope with a self-signed record for
   * `pubKey` (defaults to `localPodId`). Only ever takes effect (during
   * replay, on every peer) while no admin yet exists for this resource --
   * see the module doc comment's "Admin bootstrapping" section. Safe to
   * call even if an admin already exists (the resulting record simply
   * never becomes effective anywhere), but callers should only invoke this
   * when actually creating a brand-new resource, not on every re-attach.
   *
   * @param {string} [pubKey]
   * @returns {Promise<void>}
   */
  async bootstrapAdmin(pubKey = this.#localPodId) {
    const record = await this.#buildRecord({
      pubKey,
      scope: this.adminScope,
      action: 'grant',
      signedByPodId: pubKey,
    })
    this.#addLocal(record)
    await this.#replay()
  }

  // -----------------------------------------------------------------------
  // Verification (Phase D's core security property)
  // -----------------------------------------------------------------------

  /**
   * Verify a record's signature AND that its claimed `signedBy` identity is
   * actually bound to the embedded public key bytes. Never throws --
   * returns false for anything malformed, forged, or tampered.
   *
   * @param {*} record
   * @returns {Promise<boolean>}
   */
  async #verifyRecord(record) {
    try {
      if (!record || typeof record !== 'object') return false
      const { pubKey, scope, action, at, signedBy, signedByPubKeyBytes, signature } = record
      if (typeof pubKey !== 'string' || !pubKey) return false
      if (typeof scope !== 'string' || !scope.startsWith(`${this.#resource}:`)) return false
      if (action !== 'grant' && action !== 'revoke') return false
      if (typeof at !== 'number' || !Number.isFinite(at)) return false
      if (typeof signedBy !== 'string' || !signedBy) return false
      if (typeof signedByPubKeyBytes !== 'string' || typeof signature !== 'string') return false

      const rawPubKeyBytes = decodeBase64url(signedByPubKeyBytes)
      const sigBytes = decodeBase64url(signature)

      // Identity binding: the claimed `signedBy` string must actually BE
      // derived from the embedded public key bytes -- otherwise anyone
      // could claim to be any podId while signing with their own key.
      const derivedPodId = await podIdFromRawPublicKey(rawPubKeyBytes)
      if (derivedPodId !== signedBy) return false

      const payload = new TextEncoder().encode(signedPayloadOf({ pubKey, scope, action, at, signedBy }))
      return await this.#wallet.verify(rawPubKeyBytes, payload, sigBytes)
    } catch {
      // Malformed base64url, wrong-length keys/signatures, etc. are all
      // "reject", never a thrown error the caller has to remember to catch.
      return false
    }
  }

  // -----------------------------------------------------------------------
  // Merge (remote input -- the only path untrusted data enters this log)
  // -----------------------------------------------------------------------

  /**
   * Merge a remote peer's serialized `ORSet` state
   * (`{elements: [{element, tags}], tombstones: [...]}`, as produced by
   * `toJSON()`/exchanged over the wire) into this log. Every element is
   * independently parsed and verified BEFORE being admitted -- a record
   * that fails verification (bad signature, tampered field, forged
   * identity binding) is discarded here and never reaches the underlying
   * `ORSet`, let alone `PeerRegistry`.
   *
   * Tombstones are never honoured: this log never calls `ORSet.remove()`
   * (see module doc comment), so a remote tombstone claim can only ever be
   * meaningless noise, not a byte-for-byte trustworthy directive -- it is
   * always ignored rather than blindly merged in.
   *
   * @param {{elements: Array<{element: string, tags: string[]}>, tombstones?: string[]}} remoteOrSetJSON
   * @returns {Promise<void>}
   */
  async mergeRemote(remoteOrSetJSON) {
    if (!remoteOrSetJSON || !Array.isArray(remoteOrSetJSON.elements)) return

    const acceptedElements = []
    for (const entry of remoteOrSetJSON.elements) {
      if (!entry || typeof entry.element !== 'string' || !Array.isArray(entry.tags)) continue
      let record
      try {
        record = JSON.parse(entry.element)
      } catch {
        this.#onLog('grant-log:reject-malformed', { resource: this.#resource })
        continue
      }
      const valid = await this.#verifyRecord(record)
      if (!valid) {
        this.#onLog('grant-log:reject-invalid-signature', { resource: this.#resource, record })
        continue
      }
      acceptedElements.push(entry)
    }

    const remoteSet = ORSet.fromJSON({ elements: acceptedElements, tombstones: [] })
    this.#orSet = this.#orSet.merge(remoteSet)
    await this.#replay()
  }

  // -----------------------------------------------------------------------
  // Replay
  // -----------------------------------------------------------------------

  /**
   * Deterministic total order comparator over live (parsed) records --
   * ascending `at`; ties broken `grant` before `revoke`; remaining ties
   * broken by signature bytes (arbitrary, stable, identical on every peer).
   *
   * @param {object} a
   * @param {object} b
   * @returns {number}
   */
  static #compareRecords(a, b) {
    if (a.at !== b.at) return a.at - b.at
    const rank = (r) => (r.action === 'grant' ? 0 : 1)
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    if (a.signature < b.signature) return -1
    if (a.signature > b.signature) return 1
    return 0
  }

  /**
   * Replay every currently-held record (already merge-time verified -- see
   * `mergeRemote()`/local construction, both of which only ever produce/admit
   * verified records) in deterministic order, computing the current
   * authorized admin set and per-pubKey effective grants.
   *
   * @returns {{admins: Set<string>, grants: Map<string, Set<string>>}}
   */
  #computeEffective() {
    const records = [...this.#orSet.value].map((str) => JSON.parse(str))
    records.sort(GrantLog.#compareRecords)

    const adminScope = this.adminScope
    const adminSet = new Set()
    /** @type {Map<string, Map<string, 'grant'|'revoke'>>} pubKey -> scope -> last action */
    const perPubKeyScope = new Map()

    for (const record of records) {
      const { pubKey, scope, action, signedBy } = record
      const isAdminScope = scope === adminScope
      const isBootstrap = isAdminScope && adminSet.size === 0 && action === 'grant' && signedBy === pubKey
      const authorized = isBootstrap || adminSet.has(signedBy)
      if (!authorized) continue

      let byScope = perPubKeyScope.get(pubKey)
      if (!byScope) {
        byScope = new Map()
        perPubKeyScope.set(pubKey, byScope)
      }
      byScope.set(scope, action)

      if (isAdminScope) {
        if (action === 'grant') adminSet.add(pubKey)
        else adminSet.delete(pubKey)
      }
    }

    const grants = new Map()
    for (const [pubKey, byScope] of perPubKeyScope) {
      const active = new Set()
      for (const [scope, action] of byScope) {
        if (action === 'grant') active.add(scope)
      }
      if (active.size > 0) grants.set(pubKey, active)
    }

    return { admins: adminSet, grants }
  }

  /**
   * Recompute the effective state and diff it against the previous
   * snapshot, calling `registry.grantCapabilities()`/`revokeCapabilities()`
   * ONLY for scopes that actually appeared/disappeared for each pubKey --
   * see the module doc comment's replay-diffing section for why this is
   * not just "revoke everything, re-grant the fresh set".
   */
  async #replay() {
    const next = this.#computeEffective()
    const prevGrants = this.#effective.grants

    const allPubKeys = new Set([...prevGrants.keys(), ...next.grants.keys()])
    for (const pubKey of allPubKeys) {
      const before = prevGrants.get(pubKey) || new Set()
      const after = next.grants.get(pubKey) || new Set()

      const added = [...after].filter((s) => !before.has(s))
      const removed = [...before].filter((s) => !after.has(s))

      if (added.length > 0) this.#registry.grantCapabilities(pubKey, added)
      if (removed.length > 0) this.#registry.revokeCapabilities(pubKey, removed)

      if ((added.length > 0 || removed.length > 0) && this.#onGrantChange) {
        this.#onGrantChange({ pubKey, before, after, added, removed })
      }
    }

    this.#effective = next
  }

  // -----------------------------------------------------------------------
  // Introspection / serialization
  // -----------------------------------------------------------------------

  /** @returns {{admins: string[], grants: Object<string, string[]>}} A snapshot of the last replay. */
  effective() {
    const grants = {}
    for (const [pubKey, scopes] of this.#effective.grants) grants[pubKey] = [...scopes]
    return { admins: [...this.#effective.admins], grants }
  }

  /** @returns {object} The underlying `ORSet`'s serialized state, for wire transmission. */
  toJSON() {
    return this.#orSet.toJSON()
  }
}

// ---------------------------------------------------------------------------
// MeshService wiring (Phase C consumer)
// ---------------------------------------------------------------------------

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) that
 * attaches a `GrantLog` for `resource` to a `PeerNode`, routing its wire
 * payloads over `ctx.onIncomingData()`/`ctx.sendTo()` under `envelopeType`.
 *
 * Known Phase C friction, noted per this phase's brief rather than silently
 * worked around: `attachService()`'s per-service handle is `{name,
 * backendScheme, teardown}` -- there is no field carrying the constructed
 * service instance back to the caller, so a `services: [...]` consumer that
 * (unlike a netway `Backend`) needs to actively call methods on what it
 * attached (`grant()`, `revoke()`, `bootstrapAdmin()`, `syncWith()`) has no
 * route to it through `attachService()`'s own return value alone. This
 * factory works around that with an `onReady(api)` callback invoked
 * synchronously from inside `attach()`, which is also why `bootstrapAdmin`
 * is NOT offered as an auto-run-on-attach constructor option: `MeshService.
 * attach()` is called synchronously and its return value is checked with
 * `typeof attachTeardown === 'function'` (`mesh-service.mjs`) -- an async
 * `attach()` would return a Promise there, which is not a function, so
 * `attachService()` would silently never call its teardown. Any
 * async setup this kind of service needs (signing a bootstrap record
 * requires `crypto.subtle`, which is inherently async) therefore has to be
 * exposed as a separately-awaitable method on the instance the caller gets
 * back via `onReady`, not run eagerly inside `attach()` itself. Worth
 * considering for a future Phase-C revision: an optional `instance` field
 * on `attachService()`'s returned handle.
 *
 * @param {object} opts
 * @param {string} opts.resource - e.g. `s3:my-bucket`. See `GrantLog`.
 * @param {string} [opts.envelopeType='grant-log']
 * @param {(api: {resource: string, grant: Function, revoke: Function,
 *   bootstrapAdmin: Function, syncWith: Function, effective: Function,
 *   toJSON: Function}) => void} [opts.onReady] - Invoked synchronously
 *   inside `attach()` with the service's public API. This is the only way
 *   to get a handle back to call `grant()`/`bootstrapAdmin()`/etc. later
 *   (see the friction note above).
 * @param {Function} [opts.onLog]
 * @param {(change: {pubKey: string, before: Set<string>, after: Set<string>,
 *   added: string[], removed: string[]}) => void} [opts.onGrantChange] -
 *   Forwarded to `GrantLog`'s constructor. See that module's doc comment's
 *   "Change notification" section -- this is Phase E's (`key-distribution.mjs`)
 *   hook into "a pubKey just gained some capability on this resource".
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createGrantLogService({ resource, envelopeType = DEFAULT_ENVELOPE_TYPE, onReady, onLog, onGrantChange } = {}) {
  if (!resource || typeof resource !== 'string') {
    throw new Error('createGrantLogService: resource is required and must be a non-empty string')
  }

  return {
    name: `grant-log:${resource}`,

    attach(peerNode, ctx) {
      const grantLog = new GrantLog({
        resource,
        localPodId: peerNode.podId,
        wallet: peerNode.wallet,
        registry: ctx.registry,
        onLog,
        onGrantChange,
      })

      const unsubscribe = ctx.onIncomingData(envelopeType, (fromPubKey, data) => {
        if (!data || data.resource !== resource || !data.orSet) return
        grantLog.mergeRemote(data.orSet).catch((err) => {
          if (onLog) onLog('grant-log-service:merge-error', { from: fromPubKey, resource, error: err?.message || String(err) })
        })
      })

      async function syncWith(pubKey) {
        await ctx.sendTo(pubKey, envelopeType, { resource, orSet: grantLog.toJSON() })
      }

      const api = {
        resource,
        grant: (pubKey, actions, opts) => grantLog.grant(pubKey, actions, opts),
        revoke: (pubKey, actions, opts) => grantLog.revoke(pubKey, actions, opts),
        bootstrapAdmin: (pubKey) => grantLog.bootstrapAdmin(pubKey),
        syncWith,
        effective: () => grantLog.effective(),
        toJSON: () => grantLog.toJSON(),
      }

      if (typeof onReady === 'function') onReady(api)

      return () => {
        unsubscribe()
      }
    },
  }
}

export { DEFAULT_ENVELOPE_TYPE, ADMIN_ACTION }
