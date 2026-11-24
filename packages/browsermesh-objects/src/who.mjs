/**
 * who.mjs -- the caller identity handed to wsh's object layer: the one place
 * where a mesh peer is turned into the layer's notion of "who".
 *
 * Over a mesh channel the caller is the channel's VERIFIED peer: a pod id, the
 * key the session is bound to, never a field of a message. wsh's layer asks
 * for `who: { username, fingerprint }` (the shape of a wsh key login). A pod id
 * is not a wsh fingerprint, and putting one in `fingerprint` would be a lie
 * that other code may rely on (a log line, a revocation by fingerprint), so
 * this adapter does not: `username` and `fingerprint` stay null and the pod id
 * travels in `podId`, the neutral slot (@johnhenry/wsh >= 0.49 names it; on
 * 0.48 the layer passes the object it was given through to `authorize`
 * untouched, which is how this adapter reads it back).
 *
 * Every decision of this package is made from `who.podId` and from nothing
 * else; the layer's own `fingerprint` is never consulted.
 */

/** @param {string} podId the channel's verified peer @returns {{ username: null, fingerprint: null, podId: string }} */
export function whoFor(podId) {
  if (typeof podId !== 'string' || !podId) throw new TypeError('whoFor: the channel has no verified peer')
  return Object.freeze({ username: null, fingerprint: null, podId })
}

/** The pod id a `who` names, or null when it names none (then nothing is allowed). */
export function podIdOf(who) {
  const id = who?.podId
  return typeof id === 'string' && id ? id : null
}
