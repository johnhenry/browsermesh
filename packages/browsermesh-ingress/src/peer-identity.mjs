/**
 * peer-identity.mjs -- what is VERIFIED about the pod at the other end of a link, as opposed to merely claimed.
 *
 * The protocol channel hands a handler `peer`, a string: the pod id the session is addressed by. Whether that id was PROVEN
 * on the link is a property of the transport underneath, and the channel does not carry it. This file adds the missing
 * statement as an extra object (`{ podId, verified, keyId?, publicKey? }`) given to the hooks as an extra argument, so
 * nothing that already reads `peer` as a string changes.
 *
 * `verified` says how the identity was established on THIS link:
 *   'bound'  a direct WebRTC connection on which the peer proved possession of the key behind its pod id, over the DTLS
 *            fingerprints of the descriptions both ends applied (the transport's identity binding)
 *   'wsh'    a wsh peer link: the login key is the pod's key (the pod id is the hash of it) and the dialler pins the host
 *            key to the pod id it meant to reach; the session is sealed
 *   'key'    more than one of those at once (each is key-proven; the kind that carried a given frame is not recorded)
 *   'none'   nothing was proven: the pod id is whatever the session was addressed by (a link that has no identity, a
 *            transport that only has a relay vouching for who is on the other end, an unbound WebRTC connection, a node
 *            this package was not told about). `keyId` and `publicKey` are absent.
 *
 * A pod id is the base64url SHA-256 of the pod's raw Ed25519 public key, so on a link where the id is proven the key's
 * hash is proven too: `keyId` is that value (equal to `podId`). `publicKey` (the 32 raw bytes) is present only when the
 * source of the link's identity supplied it AND it hashes to `podId`.
 *
 * Web-standard globals only.
 */

/**
 * @typedef {object} PeerIdentity
 * @property {string} podId - the pod id of the other end (the same string the hooks' `peer` has)
 * @property {'bound'|'wsh'|'key'|'none'} verified - how the identity was established on this link (see the file comment)
 * @property {string} [keyId] - present when `verified` is not `'none'`: the base64url SHA-256 of the pod's public key (equal to `podId`)
 * @property {Uint8Array} [publicKey] - present only when the source supplied the 32 raw key bytes and they hash to `podId`
 */

/** The `verified` values that mean a key was proven on the link. */
export const KEY_PROVEN = Object.freeze(['bound', 'wsh', 'key'])
export const PEER_VERIFIED = Object.freeze([...KEY_PROVEN, 'none'])

const B64 = (bytes) => {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The pod id of a raw Ed25519 public key: base64url(SHA-256(raw key)).
 * @param {Uint8Array} raw - 32 bytes
 * @returns {Promise<string>}
 */
export async function podIdOfRawKey(raw) {
  return B64(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', raw)))
}

/** A peer about which nothing was proven. Never carries a key. */
export const unverifiedPeer = (podId) => Object.freeze({ podId, verified: 'none' })

/**
 * Turn what a link-identity source said into the peer object a hook gets. A source can only ever narrow: anything that is
 * not a recognised proof (a missing answer, an unknown `verified`, a key that does not hash to the pod id, a throw) is
 * `'none'`.
 *
 * @param {string} podId
 * @param {{ verified?: string, publicKey?: Uint8Array }|undefined|null} found
 * @returns {Promise<Readonly<{ podId: string, verified: string, keyId?: string, publicKey?: Uint8Array }>>}
 */
export async function describePeer(podId, found) {
  if (!found || typeof found !== 'object' || !KEY_PROVEN.includes(found.verified)) return unverifiedPeer(podId)
  const peer = { podId, verified: found.verified, keyId: podId }
  if (found.publicKey !== undefined) {
    const key = found.publicKey
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) return unverifiedPeer(podId)
    let hash
    try { hash = await podIdOfRawKey(key) } catch { return unverifiedPeer(podId) }
    if (hash !== podId) return unverifiedPeer(podId)
    peer.publicKey = new Uint8Array(key)
  }
  return Object.freeze(peer)
}

/**
 * Ask a link-identity source about `podId`. Never throws.
 * @param {((podId: string) => (object|undefined|Promise<object|undefined>))|null} source
 */
export async function resolvePeer(source, podId) {
  if (!source) return unverifiedPeer(podId)
  let found
  try { found = await source(podId) } catch { found = undefined }
  return describePeer(podId, found)
}

/**
 * The link-identity source for a mesh node (`createMeshNode`'s result, or anything with the same few members): it reads
 * what the transports under the node's sessions to a pod say, and reports a proof only when EVERY live session to that pod
 * carries one, because a frame attributed to the pod may have arrived on any of them.
 *
 *   webrtc session  proven when its connection (`node.meshManager.getConnection(podId, connectionId)`) is `bound`
 *   wsh session     proven when `node.wsh.links` has a connected link to the pod
 *   anything else   not proven (a relayed or otherwise vouched-for link, a transport this does not know)
 *   no live session not proven
 *
 * A session whose WebRTC connection has gone away or is not open cannot carry a frame and is not counted.
 *
 * @param {object} node - a `PeerNode` with `sessionsFor`, and (when it has them) `meshManager` and `wsh`
 * @returns {(podId: string) => ({ verified: 'bound'|'wsh'|'key' }|undefined)}
 */
export function nodeLinkIdentity(node) {
  if (!node || typeof node.sessionsFor !== 'function') throw new TypeError('nodeLinkIdentity: a mesh node (with sessionsFor) is required')
  return (podId) => {
    const kinds = new Set()
    for (const session of node.sessionsFor(podId)) {
      if (session?.state !== 'active') continue
      if (session.transport === 'webrtc') {
        const connection = node.meshManager?.getConnection?.(podId, session.connectionId)
        if (!connection || connection.isOpen !== true) continue // cannot carry a frame
        if (connection.bound !== true) return undefined
        kinds.add('bound')
      } else if (session.transport === 'wsh') {
        if (node.wsh?.links?.isConnected?.(podId) !== true) return undefined
        kinds.add('wsh')
      } else {
        return undefined
      }
    }
    if (!kinds.size) return undefined
    return { verified: kinds.size === 1 ? [...kinds][0] : 'key' }
  }
}

/** The named reasons `requireLinkKey` refuses for (also the `reason` of the error it throws). */
export const LINK_KEY_REFUSALS = Object.freeze({
  linkUnverified: 'link-unverified',
  signerUnverified: 'signer-unverified',
  signerKeyInvalid: 'signer-key-invalid',
  mismatch: 'link-key-mismatch',
})

/** What `requireLinkKey` throws to refuse; the provider logs and counts `reason`. */
export class LinkKeyRefusal extends Error {
  constructor(reason) {
    super(`refused: ${reason}`)
    this.name = 'LinkKeyRefusal'
    this.reason = reason
  }
}

/**
 * Make a `verifyRequest` (or `verifyResponse`) hook that binds the signer to the link. `verifySigner` does the signature
 * check you already do and says WHICH key made it: it receives what the hook receives and returns the verified signer's
 * raw 32-byte Ed25519 public key (a `Uint8Array`), or its key id (a string: the base64url SHA-256 of that key, the form a
 * pod id has), or anything falsy when the signature does not verify. The hook then accepts only when
 *
 *   - the link proved a key (`peer.verified` is not `'none'`), and
 *   - the signer's key is the link's key (the hash of the signer's key equals the link's `keyId`).
 *
 * Otherwise it refuses with a named reason (`link-unverified`, `signer-unverified`, `signer-key-invalid`,
 * `link-key-mismatch`): on the provider the request is refused as `request-unverified`, the reason is passed to `onLog`
 * and counted in `stats().refusals`. A request signature on its own shows that the request was not altered and that the
 * holder of the signing key made it; with this helper it must also be the pod on the other end of the link.
 *
 * The peer object is the LAST argument the hook is called with: `(request, context, peer)` on a provider's
 * `verifyRequest`, `(info, peer)` on an ingress's `verifyResponse`.
 *
 * @param {(...args: any[]) => (Uint8Array|string|false|null|undefined|Promise<Uint8Array|string|false|null|undefined>)} verifySigner
 * @returns {(...args: any[]) => Promise<true>} throws `LinkKeyRefusal` instead of returning false
 */
export function requireLinkKey(verifySigner) {
  if (typeof verifySigner !== 'function') throw new TypeError('requireLinkKey: verifySigner must be a function returning the verified signer\'s key')
  return async (...args) => {
    const peer = args[args.length - 1]
    if (!peer || typeof peer !== 'object' || !KEY_PROVEN.includes(peer.verified) || typeof peer.keyId !== 'string' || !peer.keyId) {
      throw new LinkKeyRefusal(LINK_KEY_REFUSALS.linkUnverified)
    }
    let signer
    try { signer = await verifySigner(...args) } catch { throw new LinkKeyRefusal(LINK_KEY_REFUSALS.signerUnverified) }
    if (!signer) throw new LinkKeyRefusal(LINK_KEY_REFUSALS.signerUnverified)
    let keyId
    if (typeof signer === 'string') keyId = signer
    else if (signer instanceof Uint8Array && signer.byteLength === 32) keyId = await podIdOfRawKey(signer)
    else throw new LinkKeyRefusal(LINK_KEY_REFUSALS.signerKeyInvalid)
    if (keyId !== peer.keyId) throw new LinkKeyRefusal(LINK_KEY_REFUSALS.mismatch)
    return true
  }
}
