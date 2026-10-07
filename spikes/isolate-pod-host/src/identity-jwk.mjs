/**
 * identity-jwk.mjs — JWK (de)serialization helpers for PodIdentity.
 *
 * `@johnhenry/browsermesh-primitives`'s `PodIdentity` (packages/browsermesh-primitives/src/identity.mjs)
 * only knows how to `generate()` a fresh Ed25519 keypair or be constructed
 * directly from an in-memory `CryptoKeyPair` — there is no "import an
 * existing keypair from storage" path. A Durable Object needs exactly that:
 * load a keypair from `ctx.storage` on `/boot`, or generate and persist one
 * the first time.
 *
 * This is the "smallest possible helper" called for in issue #185 §8 WP2:
 * it belongs in the spike, not in the package, because the real shape of a
 * storage-backed identity (raw seed vs JWK, encrypted-at-rest or not) is an
 * open question the issue defers to the spike (§10, open question 2). We
 * went with extractable JWK keys, which the issue explicitly allows for the
 * spike ("extractable is acceptable for the spike and the issue says so").
 *
 * Keys are extractable, which means whoever can read Durable Object storage
 * (the host operator) can read the pod's private key — this is the same
 * "host can always read a hosted pod's key" limitation issue #185 §7
 * already names for isolate pods generally, not a new one introduced here.
 */

import { PodIdentity, derivePodId } from '@johnhenry/browsermesh-primitives'

/**
 * Export a PodIdentity's keypair as a JSON-serializable JWK pair, suitable
 * for `ctx.storage.put()`.
 *
 * @param {InstanceType<typeof PodIdentity>} identity
 * @returns {Promise<{ podId: string, privateJwk: JsonWebKey, publicJwk: JsonWebKey }>}
 */
export async function exportIdentityToJwk(identity) {
  const [privateJwk, publicJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', identity.keyPair.privateKey),
    crypto.subtle.exportKey('jwk', identity.keyPair.publicKey),
  ])
  return { podId: identity.podId, privateJwk, publicJwk }
}

/**
 * Reconstruct a PodIdentity from a JWK pair previously produced by
 * `exportIdentityToJwk`.
 *
 * @param {{ privateJwk: JsonWebKey, publicJwk: JsonWebKey }} stored
 * @returns {Promise<InstanceType<typeof PodIdentity>>}
 */
export async function importIdentityFromJwk({ privateJwk, publicJwk }) {
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey('jwk', privateJwk, { name: 'Ed25519' }, true, ['sign']),
    crypto.subtle.importKey('jwk', publicJwk, { name: 'Ed25519' }, true, ['verify']),
  ])
  const podId = await derivePodId(publicKey)
  return new PodIdentity({ keyPair: { privateKey, publicKey }, podId })
}

/**
 * Load the identity for this Durable Object from storage, generating and
 * persisting a fresh one on first boot.
 *
 * @param {DurableObjectStorage} storage
 * @returns {Promise<InstanceType<typeof PodIdentity>>}
 */
export async function loadOrCreateIdentity(storage) {
  const stored = await storage.get('identity')
  if (stored && stored.privateJwk && stored.publicJwk) {
    return importIdentityFromJwk(stored)
  }
  const identity = await PodIdentity.generate()
  const record = await exportIdentityToJwk(identity)
  await storage.put('identity', record)
  return identity
}
