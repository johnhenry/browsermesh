/**
 * key-distribution.mjs -- Phase E of the mesh-native-services plan
 * ("CloudStorage: S3-like object storage"): whenever a bucket's replicated
 * `GrantLog` (Phase D, `grant-log.mjs`) admits a peer's first capability on a
 * bucket, a peer that already holds the bucket's AES-256-GCM key sends it to
 * the newly-granted peer over a **new, dedicated** point-to-point channel,
 * encrypted to the recipient -- never over the manifest/chunk sync channels,
 * and never in plaintext.
 *
 * ---------------------------------------------------------------------------
 * Critical open question the plan explicitly flagged, resolved by inspection
 * (not assumption) before writing this file:
 *
 * Does `browsermesh-core`/`browsermesh-primitives` already expose an
 * asymmetric encrypt-to-pubkey primitive? YES: `browsermesh-core`'s
 * `group-keys.mjs` (`wrapKeyForMember()`/`unwrapKeyForMember()`) already
 * implements exactly this -- X25519 ECDH + AES-GCM key wrap, ECIES-style
 * (a fresh ephemeral X25519 keypair per envelope, so a single envelope's
 * compromise never exposes any other envelope or the sender's long-term
 * key), built entirely on WebCrypto (`crypto.subtle`), with no third-party
 * crypto dependency -- consistent with every `package.json` in this repo
 * having zero crypto npm dependencies anywhere (`grep`-verified). This file
 * reuses those two functions as-is rather than adding a new primitive.
 *
 * The one real wrinkle: `wrapKeyForMember()`/`unwrapKeyForMember()` operate
 * on X25519 keys, not the Ed25519 identity keypair every peer's `podId` is
 * derived from (`browsermesh-primitives/src/identity.mjs`) -- X25519 (key
 * agreement) and Ed25519 (signatures) are different curves with no WebCrypto-
 * exposed conversion between them, and this repo has no Ed25519-to-X25519
 * conversion utility (deliberately not adding one here: that conversion is
 * real elliptic-curve field arithmetic with no test-vector coverage anywhere
 * in this family, a meaningfully riskier thing to hand-roll than reusing an
 * already-tested primitive). So "encrypted to the recipient's identity
 * public key" is implemented as: each peer generates (once, on attach) its
 * own X25519 "encryption key" the same way `GroupKeyManager.initEncryption()`
 * already does, and this file adds a minimal `announce`/`deliver` handshake
 * (below) so a sender can learn a recipient's X25519 key before it can wrap
 * anything for them -- the recipient's *identity* (`podId`) is still what
 * every message is addressed to/signed by, and it's the identity's Ed25519
 * key that authenticates the actual key-bearing `deliver` message (see
 * below); only the wrap/unwrap step itself runs on the companion X25519 key.
 *
 * ---------------------------------------------------------------------------
 * Wire protocol -- two message kinds sharing one envelope `type`
 * (default `'bucket-key'`), both scoped to one `resource` (matching
 * `GrantLog`'s `s3:<bucketId>` convention exactly, since the two logs must
 * agree on the same bucket):
 *
 *   `{ type, resource, kind: 'announce', encryptionPublicKey }`
 *     Advertises the sender's own X25519 public key (raw bytes, base64).
 *     Not itself signed -- see "Trust model" below for why that's fine.
 *     Sent in two situations:
 *       (a) by a peer that just gained its OWN first capability on this
 *           resource (`onGrantChange` fired with `pubKey === localPodId`),
 *           addressed to every currently-known admin, so they can push the
 *           key back; and
 *       (b) implicitly answered by the RECEIVING side re-checking the
 *           GrantLog's current effective state on every inbound `announce`
 *           (see `#maybeDeliverTo`) -- covers the reverse ordering, where a
 *           peer was granted access before it ever announced (e.g. it was
 *           offline, or attached this service after the grant already
 *           happened).
 *
 *   `{ type, resource, kind: 'deliver', envelope: {ephemeralPublicKey,
 *      wrappedKey, iv}, at, signedBy, signedByPubKeyBytes, signature }`
 *     The actual wrapped bucket key. `envelope` is exactly
 *     `wrapKeyForMember()`'s return shape. The rest mirrors `grant-log.mjs`'s
 *     own self-verifying record shape byte-for-byte (same canonical-JSON-
 *     over-sorted-keys signing convention, same "derive the podId from the
 *     embedded raw public key bytes and require it to match the claimed
 *     `signedBy`" identity binding) -- deliberately duplicated rather than
 *     imported, matching this file's siblings' own established convention of
 *     small, self-contained per-file crypto helpers rather than a shared
 *     signing-record module.
 *
 * ---------------------------------------------------------------------------
 * Trust model for `deliver` (this phase's actual security property, and the
 * one this phase's tests exist to prove):
 *
 *   1. Signature + identity binding: `signedBy` must be the real podId
 *      derived from the embedded raw Ed25519 public key bytes, AND the
 *      signature over the canonical payload must verify against those same
 *      bytes. A record failing either check is discarded outright -- this
 *      alone rejects "unsigned" or "wrong key" forgeries.
 *   2. Authorization: even a validly self-signed record is discarded unless
 *      `signedBy` is CURRENTLY (per this peer's own locally-replayed
 *      `GrantLog` effective state, the same trust root `PeerRegistry`
 *      already relies on) either this resource's admin, or holds at least
 *      one grant on this resource -- i.e. is someone this protocol's own
 *      design would legitimately have handed the key to already. This
 *      rejects "claiming to be from a non-admin/non-key-holder".
 *
 * `announce` deliberately has NO signature layer. Rationale: its only effect
 * is "the sender learns an X25519 public key to wrap a key toward" -- a
 * forged announce (attacker claims to be podId P with the attacker's own
 * X25519 key) makes a recipient wrap the real bucket key toward the
 * ATTACKER's key, but `ctx.sendTo()` (`mesh-service.mjs`) still routes the
 * resulting `deliver` message through `PeerNode`'s own authenticated,
 * podId-addressed session for P (`PeerNode.sendTo` throws if there is no
 * active session for that pubKey) -- so the real P receives ciphertext it
 * cannot unwrap (a delivery denial-of-service against P), not a
 * confidentiality leak, unless the attacker has ALSO compromised the
 * transport-level session binding itself, a strictly larger threat model
 * this whole family's identity/session layer is already relied on to
 * prevent everywhere else, not something this one file can additionally
 * defend against. This is a deliberate, documented scope boundary, not an
 * oversight: the actual secret-bearing message (`deliver`) is fully signed
 * and authorization-checked; the key-agreement bootstrapping step
 * (`announce`) is not, because its own worst case is self-limiting.
 *
 * ---------------------------------------------------------------------------
 * Composition with `createGrantLogService()` (Phase D): this service's
 * `onGrantChange` hook must be wired into the SAME `GrantLog` instance this
 * service authorizes `deliver` messages against, and `GrantLog`'s
 * `onGrantChange` is a single constructor-time callback (see that module's
 * doc comment), not a multi-subscriber event bus -- so attach THIS service
 * first (its `attach()` returns `{api}` synchronously, before anything can
 * fire), then attach `createGrantLogService()` passing this service's
 * `api.handleGrantChange` as `onGrantChange` and capturing the GrantLog's own
 * `api` via `onReady` into a variable this service's `getEffective` closure
 * reads lazily:
 *
 *   let grantLogApi
 *   const keyDist = attachService(node, network, createKeyDistributionService({
 *     resource, getLocalKey, setReceivedKey,
 *     getEffective: () => grantLogApi.effective(),
 *   }))
 *   attachService(node, network, createGrantLogService({
 *     resource,
 *     onGrantChange: keyDist.api.handleGrantChange,
 *     onReady: (api) => { grantLogApi = api },
 *   }))
 *
 * This is the same class of ordering friction `grant-log.mjs`'s own doc
 * comment already documents for `onReady` (Phase C's `attach()` being
 * synchronous, non-awaited) -- not a new problem introduced here.
 *
 * ---------------------------------------------------------------------------
 * PERMANENT, DOCUMENTED LIMITATION (also stated in `cloud-storage-backend.mjs`
 * and worth restating here, since this is the file that actually ships the
 * key): revoking a peer's grant stops FUTURE key distribution (this file
 * simply never delivers to a peer whose effective grants are empty) and
 * future chunk replication (Phase G), but cannot retroactively erase a key
 * -- or any plaintext already decrypted with it -- already delivered to a
 * since-revoked peer. This bucket's AES key is never rotated on revoke in
 * this plan. This is a fundamental property of any such scheme, not a bug to
 * fix later.
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`, Phase 1 of the mesh-KV-and-
 * observability plan -- see `mesh-service.mjs`'s module doc comment for the
 * full convention this follows). Three curated events, not a mechanical
 * conversion of this file's `onLog` calls:
 *
 *   - `key-distribution:key-sent` `{resource, to}` -- this peer successfully
 *     pushed the bucket key to a newly-announced/newly-granted peer.
 *   - `key-distribution:key-received` `{resource, from}` -- this peer
 *     accepted and imported a `deliver` record (full trust-model
 *     verification above already passed by this point).
 *   - `key-distribution:delivery-rejected` `{resource, from, reason}` -- a
 *     `deliver` record was discarded (`reason` is one of
 *     `'malformed'`/`'identity-mismatch'`/`'bad-signature'`/
 *     `'unauthorized-sender'`); this is this file's core security property
 *     (see "Trust model for deliver" above), so its rejections are exactly
 *     the kind of transition worth a dashboard being able to see.
 *
 * No browser-only imports at module level.
 */

import { encodeBase64url, decodeBase64url } from '@johnhenry/browsermesh-primitives'
// @johnhenry/browsermesh-core (an optional peerDependency) is imported
// lazily, at each of the three call sites below, rather than eagerly here
// -- so this module doesn't force it on every consumer of this package's
// top-level `.` entrypoint. Dynamic import() is cached by the module
// system after the first real resolution, so this costs nothing on repeat
// calls. See the CHANGELOG entry documenting this fix for the full
// rationale.

/** Default `envelope.type` used to route key-distribution payloads on the shared `onIncomingData()` bus. */
const DEFAULT_ENVELOPE_TYPE = 'bucket-key'

// ---------------------------------------------------------------------------
// Canonical JSON / signing helpers -- deliberately duplicated from
// grant-log.mjs rather than imported/shared, matching this file's own doc
// comment and this family's established convention of small self-contained
// per-file crypto helpers (see e.g. cloud-storage-backend.mjs's own
// AES helpers vs. peer-encrypted-store.mjs's).
// ---------------------------------------------------------------------------

/** @param {object} obj @returns {string} */
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
 * The exact fields signed in a `deliver` record -- everything except
 * `signedByPubKeyBytes`/`signature` themselves.
 * @param {{resource: string, ephemeralPublicKey: string, wrappedKey: string, iv: string, at: number, signedBy: string}} fields
 * @returns {string}
 */
function signedPayloadOf(fields) {
  return canonicalJSON({
    resource: fields.resource,
    ephemeralPublicKey: fields.ephemeralPublicKey,
    wrappedKey: fields.wrappedKey,
    iv: fields.iv,
    at: fields.at,
    signedBy: fields.signedBy,
  })
}

/**
 * base64url(SHA-256(rawPublicKeyBytes)) -- identical to `derivePodId()`'s own
 * definition (`browsermesh-primitives/src/identity.mjs`), duplicated here for
 * the same reason `grant-log.mjs` duplicates it: the raw bytes are already in
 * hand (decoded from the record), importing them into a `CryptoKey` purely to
 * re-export them back out would be wasted work.
 * @param {Uint8Array} rawPublicKeyBytes
 * @returns {Promise<string>}
 */
async function podIdFromRawPublicKey(rawPublicKeyBytes) {
  const hash = await crypto.subtle.digest('SHA-256', rawPublicKeyBytes)
  return encodeBase64url(new Uint8Array(hash))
}

// ---------------------------------------------------------------------------
// Base64 helpers (plain base64, matching group-keys.mjs's own encoding for
// X25519 public keys and wrap envelopes -- NOT base64url, kept distinct from
// the base64url helpers above which are only ever used for the Ed25519
// identity-signature fields, matching grant-log.mjs's own convention there).
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

// ---------------------------------------------------------------------------
// MeshService wiring
// ---------------------------------------------------------------------------

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) that
 * distributes one bucket's AES key to newly-granted peers. See the module
 * doc comment for the full protocol/trust-model writeup and the required
 * composition order with `createGrantLogService()`.
 *
 * @param {object} opts
 * @param {string} opts.resource - e.g. `s3:my-bucket`. Must be the SAME
 *   resource string the paired `GrantLog` uses.
 * @param {() => {admins: string[], grants: Object<string, string[]>}} opts.getEffective -
 *   Typically `() => grantLogApi.effective()`. Evaluated lazily on every
 *   message/change, so it's safe to pass a closure over a variable that
 *   isn't assigned yet at the time this descriptor is constructed (see the
 *   module doc comment's composition-order note).
 * @param {() => Promise<Uint8Array|null>} opts.getLocalKey - Typically
 *   `() => backend.peekKeyRaw()` (`cloud-storage-backend.mjs`, Phase E's
 *   addition) -- must NOT auto-create a key as a side effect, or every peer
 *   that merely attaches this service would spontaneously mint its own,
 *   never-to-be-reconciled bucket key.
 * @param {(rawKeyBytes: Uint8Array) => Promise<void>} opts.setReceivedKey -
 *   Typically `(bytes) => backend.importKeyRaw(bytes)`.
 * @param {string} [opts.envelopeType='bucket-key']
 * @param {Function} [opts.onLog]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createKeyDistributionService({
  resource,
  getEffective,
  getLocalKey,
  setReceivedKey,
  envelopeType = DEFAULT_ENVELOPE_TYPE,
  onLog,
} = {}) {
  if (!resource || typeof resource !== 'string') {
    throw new Error('createKeyDistributionService: resource is required and must be a non-empty string')
  }
  if (typeof getEffective !== 'function') {
    throw new Error('createKeyDistributionService: getEffective is required and must be a function')
  }
  if (typeof getLocalKey !== 'function') {
    throw new Error('createKeyDistributionService: getLocalKey is required and must be a function')
  }
  if (typeof setReceivedKey !== 'function') {
    throw new Error('createKeyDistributionService: setReceivedKey is required and must be a function')
  }
  const log = onLog || (() => {})

  return {
    name: `key-distribution:${resource}`,

    attach(peerNode, ctx) {
      const localPodId = peerNode.podId

      /** @type {Promise<CryptoKeyPair>|null} This peer's own X25519 encryption keypair, generated lazily on first need. */
      let keyPairPromise = null
      /** @type {string|null} Cached base64 raw public key for `keyPairPromise`. */
      let localPublicKeyB64 = null

      /** @type {Map<string, CryptoKey>} podId -> their announced X25519 public key. */
      const knownEncryptionKeys = new Map()

      function ensureKeyPair() {
        if (!keyPairPromise) {
          keyPairPromise = import('@johnhenry/browsermesh-core')
            .then(({ generateEncryptionKeyPair }) => generateEncryptionKeyPair())
            .then(async (kp) => {
              const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
              localPublicKeyB64 = toBase64(raw)
              return kp
            })
        }
        return keyPairPromise
      }

      function hasAnyGrant(pubKey, effective) {
        return effective.admins.includes(pubKey) || (effective.grants[pubKey]?.length ?? 0) > 0
      }

      /** Wrap `rawKeyBytes` for `recipientPublicKey` and sign a `deliver` record over the result. */
      async function buildDeliverRecord(rawKeyBytes, recipientPublicKey) {
        const { wrapKeyForMember } = await import('@johnhenry/browsermesh-core')
        const importable = await crypto.subtle.importKey('raw', rawKeyBytes, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
        const envelope = await wrapKeyForMember(importable, recipientPublicKey)

        const at = Date.now()
        const signedByPubKeyBytes = await peerNode.wallet.getPublicKeyBytes(localPodId)
        const unsigned = { resource, ephemeralPublicKey: envelope.ephemeralPublicKey, wrappedKey: envelope.wrappedKey, iv: envelope.iv, at, signedBy: localPodId }
        const payload = new TextEncoder().encode(signedPayloadOf(unsigned))
        const signature = await peerNode.wallet.sign(localPodId, payload)

        return {
          resource,
          kind: 'deliver',
          envelope,
          at,
          signedBy: localPodId,
          signedByPubKeyBytes: encodeBase64url(signedByPubKeyBytes),
          signature: encodeBase64url(signature),
        }
      }

      /** If we hold the key and already know `targetPodId`'s X25519 pubkey, push it now. Silent no-op otherwise. */
      async function maybeDeliverTo(targetPodId) {
        const recipientKey = knownEncryptionKeys.get(targetPodId)
        if (!recipientKey) return
        const rawKey = await getLocalKey()
        if (!rawKey) return

        try {
          const record = await buildDeliverRecord(rawKey, recipientKey)
          await ctx.sendTo(targetPodId, envelopeType, record)
          log('key-distribution:sent', { to: targetPodId, resource })
          ctx.emit('key-distribution:key-sent', { resource, to: targetPodId })
        } catch (err) {
          log('key-distribution:send-error', { to: targetPodId, resource, error: err?.message || String(err) })
        }
      }

      /** We ourselves just gained access -- announce our X25519 pubkey to every current admin so they can push us the key. */
      async function announceToAdmins() {
        await ensureKeyPair()
        const effective = getEffective()
        for (const adminPodId of effective.admins) {
          if (adminPodId === localPodId) continue
          try {
            await ctx.sendTo(adminPodId, envelopeType, { resource, kind: 'announce', encryptionPublicKey: localPublicKeyB64 })
          } catch (err) {
            log('key-distribution:announce-error', { to: adminPodId, resource, error: err?.message || String(err) })
          }
        }
      }

      async function handleAnnounce(fromPubKey, msg) {
        if (typeof msg.encryptionPublicKey !== 'string') {
          log('key-distribution:reject-malformed-announce', { from: fromPubKey, resource })
          return
        }
        let cryptoKey
        try {
          const raw = fromBase64(msg.encryptionPublicKey)
          cryptoKey = await crypto.subtle.importKey('raw', raw, { name: 'X25519' }, true, [])
        } catch (err) {
          log('key-distribution:reject-malformed-announce', { from: fromPubKey, resource, error: err?.message || String(err) })
          return
        }
        knownEncryptionKeys.set(fromPubKey, cryptoKey)

        // The reverse ordering: fromPubKey was already granted access before
        // we learned their key (or before they announced it). Catch up now.
        if (hasAnyGrant(fromPubKey, getEffective())) {
          await maybeDeliverTo(fromPubKey)
        }
      }

      async function handleDeliver(fromPubKey, msg) {
        const { envelope, at, signedBy, signedByPubKeyBytes, signature } = msg
        if (!envelope || typeof envelope.ephemeralPublicKey !== 'string' ||
          typeof envelope.wrappedKey !== 'string' || typeof envelope.iv !== 'string') {
          log('key-distribution:reject-malformed-deliver', { from: fromPubKey, resource })
          ctx.emit('key-distribution:delivery-rejected', { resource, from: fromPubKey, reason: 'malformed' })
          return
        }
        if (typeof at !== 'number' || !Number.isFinite(at) ||
          typeof signedBy !== 'string' || !signedBy ||
          typeof signedByPubKeyBytes !== 'string' || typeof signature !== 'string') {
          log('key-distribution:reject-malformed-deliver', { from: fromPubKey, resource })
          ctx.emit('key-distribution:delivery-rejected', { resource, from: fromPubKey, reason: 'malformed' })
          return
        }

        let rawPubKeyBytes
        let sigBytes
        try {
          rawPubKeyBytes = decodeBase64url(signedByPubKeyBytes)
          sigBytes = decodeBase64url(signature)
        } catch {
          log('key-distribution:reject-malformed-deliver', { from: fromPubKey, resource })
          ctx.emit('key-distribution:delivery-rejected', { resource, from: fromPubKey, reason: 'malformed' })
          return
        }

        // Identity binding: the claimed `signedBy` must actually be derived
        // from the embedded public key bytes.
        const derivedPodId = await podIdFromRawPublicKey(rawPubKeyBytes)
        if (derivedPodId !== signedBy) {
          log('key-distribution:reject-identity-mismatch', { from: fromPubKey, resource, signedBy })
          ctx.emit('key-distribution:delivery-rejected', { resource, from: fromPubKey, reason: 'identity-mismatch' })
          return
        }

        // Signature: the record must really have been signed by that key.
        const payload = new TextEncoder().encode(signedPayloadOf({ resource, ephemeralPublicKey: envelope.ephemeralPublicKey, wrappedKey: envelope.wrappedKey, iv: envelope.iv, at, signedBy }))
        let validSig = false
        try {
          validSig = await peerNode.wallet.verify(rawPubKeyBytes, payload, sigBytes)
        } catch {
          validSig = false
        }
        if (!validSig) {
          log('key-distribution:reject-bad-signature', { from: fromPubKey, resource, signedBy })
          ctx.emit('key-distribution:delivery-rejected', { resource, from: fromPubKey, reason: 'bad-signature' })
          return
        }

        // Authorization: signedBy must currently be an admin or hold at
        // least one grant on this resource -- rejects a validly self-signed
        // but unauthorized (non-admin/non-key-holder) claim.
        if (!hasAnyGrant(signedBy, getEffective())) {
          log('key-distribution:reject-unauthorized-sender', { from: fromPubKey, resource, signedBy })
          ctx.emit('key-distribution:delivery-rejected', { resource, from: fromPubKey, reason: 'unauthorized-sender' })
          return
        }

        let rawKeyBytes
        try {
          const { unwrapKeyForMember } = await import('@johnhenry/browsermesh-core')
          const keyPair = await ensureKeyPair()
          const unwrapped = await unwrapKeyForMember(envelope, keyPair.privateKey)
          rawKeyBytes = new Uint8Array(await crypto.subtle.exportKey('raw', unwrapped))
        } catch (err) {
          log('key-distribution:unwrap-error', { from: fromPubKey, resource, error: err?.message || String(err) })
          return
        }

        await setReceivedKey(rawKeyBytes)
        log('key-distribution:received', { from: fromPubKey, resource })
        ctx.emit('key-distribution:key-received', { resource, from: fromPubKey })
      }

      const unsubscribe = ctx.onIncomingData(envelopeType, (fromPubKey, msg) => {
        if (!msg || msg.resource !== resource) return
        if (msg.kind === 'announce') {
          handleAnnounce(fromPubKey, msg).catch((err) => log('key-distribution:announce-handler-error', { from: fromPubKey, resource, error: err?.message || String(err) }))
        } else if (msg.kind === 'deliver') {
          handleDeliver(fromPubKey, msg).catch((err) => log('key-distribution:deliver-handler-error', { from: fromPubKey, resource, error: err?.message || String(err) }))
        }
      })

      /**
       * `GrantLog`'s `onGrantChange` hook (`grant-log.mjs`). See the module
       * doc comment's composition-order note for how this gets wired to the
       * paired `GrantLog` instance.
       * @param {{pubKey: string, before: Set<string>, after: Set<string>, added: string[], removed: string[]}} change
       */
      function handleGrantChange({ pubKey, before, after }) {
        if (!(before.size === 0 && after.size > 0)) return // only a 0 -> nonzero transition is "newly admitted"

        if (pubKey === localPodId) {
          announceToAdmins().catch((err) => log('key-distribution:announce-error', { resource, error: err?.message || String(err) }))
        } else {
          maybeDeliverTo(pubKey).catch((err) => log('key-distribution:deliver-error', { to: pubKey, resource, error: err?.message || String(err) }))
        }
      }

      const api = {
        resource,
        handleGrantChange,
        /** @returns {Promise<string>} This peer's own X25519 public key (base64), generating it first if needed. Exposed for tests/introspection. */
        async localEncryptionPublicKey() {
          await ensureKeyPair()
          return localPublicKeyB64
        },
      }

      return {
        api,
        teardown() {
          unsubscribe()
        },
      }
    },
  }
}

export { DEFAULT_ENVELOPE_TYPE }
