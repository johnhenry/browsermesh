/**
 * who.mjs -- the caller identity handed to wsh's object layer: the one place
 * where a mesh peer is turned into the layer's notion of "who".
 *
 * Over a mesh channel the caller is the channel's VERIFIED peer: a pod id, the
 * key the session is bound to, never a field of a message. wsh's layer takes
 * `who: { username, fingerprint, podId }` (@johnhenry/wsh >= 0.49): the pod id
 * goes in `podId`, and wsh derives the fingerprint of the same key from it
 * (`normalizeIdentity`, strict: exactly 43 canonical base64url characters, the
 * SHA-256 of a public key). Nothing is spelled here that wsh already knows how
 * to spell.
 *
 * Every decision of this package is made from `who.podId` and from nothing
 * else; the layer's own `fingerprint` is never consulted.
 */
import { normalizeIdentity } from '@johnhenry/wsh/identity'

/**
 * @param {string} podId the channel's verified peer
 * @returns {Readonly<{ username: null, fingerprint: string, podId: string }>}
 * @throws {TypeError} when the channel has no verified peer, or what it names is not a pod id
 */
export function whoFor(podId) {
  if (typeof podId !== 'string' || !podId) throw new TypeError('whoFor: the channel has no verified peer')
  return Object.freeze(normalizeIdentity({ username: null, podId }))
}

/** The pod id a `who` names, or null when it names none (then nothing is allowed). */
export function podIdOf(who) {
  const id = who?.podId
  return typeof id === 'string' && id ? id : null
}
