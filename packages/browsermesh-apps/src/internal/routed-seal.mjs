/**
 * routed-seal.mjs -- end-to-end sealing of routed messages: this pod's agreement keys and statements, the
 * statements it has learned from other pods, and the seal and open operations the router calls.
 *
 * What the crypto is (key statements, ephemeral-static X25519, HKDF, AES-256-GCM) lives in
 * `@johnhenry/browsermesh-primitives` (`key-agreement.mjs`). This file owns the bookkeeping:
 *
 *  - OWN KEYS. One X25519 key pair at a time, with a statement signed by the pod's identity key. After
 *    `rotationMs` a new pair and statement replace it; the old private key is kept until ITS statement
 *    expires (messages sealed to it in the meantime still open) and is then deleted. Rotation is lazy: it
 *    happens at the next use, not on a timer.
 *  - OTHER PODS' STATEMENTS. Verified (signature against the pod id, expiry, revocation) before they are
 *    cached; a newer statement for a pod replaces an older one; bounded (`maxPeers`, oldest dropped). A
 *    statement is looked up by pod id only if it has not expired by the injected clock.
 *  - SEAL / OPEN. The associated data is the routing header the signature covers (originator, recipient,
 *    message id), so a sealed box cannot be lifted into another message or sent under another name.
 */

// A namespace import, so that an installed primitives release from before key statements existed does not
// stop this module loading: sealing is then simply unavailable (`supported` is false).
import * as primitives from '@johnhenry/browsermesh-primitives'

const {
  generateAgreementKeyPair, createKeyStatement, verifyKeyStatement, sealToStatement, openSealed, supportsKeyAgreement,
} = primitives
const DEFAULT_STATEMENT_LIFETIME_MS = primitives.DEFAULT_STATEMENT_LIFETIME_MS ?? 2 * 3_600_000
const HAS_KEY_AGREEMENT = typeof createKeyStatement === 'function' && typeof sealToStatement === 'function'

const enc = new TextEncoder()
const dec = new TextDecoder()

export const DEFAULT_ROTATION_MS = 3_600_000
export const DEFAULT_MAX_SEALED_MESSAGE_BYTES = 64 * 1024
const AAD_DOMAIN = 'browsermesh/routed-seal/v1'

export const headerBytes = (from, to, id) => enc.encode(JSON.stringify([AAD_DOMAIN, from, to, id]))

export class SealingKeys {
  #identity
  #now
  #lifetimeMs
  #rotationMs
  #maxPeers
  #maxBytes
  #revocations
  #current = null // { pair, statement, createdAt }
  #held = new Map() // kid -> { pair, notAfter }
  #peers = new Map() // podId -> { verified, statement }
  #onRotate

  /**
   * @param {object} opts
   * @param {{ podId: string, sign: Function, rawPublicKey: Function }} opts.identity
   * @param {() => number} [opts.now] - ms clock
   * @param {number} [opts.lifetimeMs] - statement lifetime (default 2 h)
   * @param {number} [opts.rotationMs] - new key after this long (default 1 h)
   * @param {number} [opts.maxPeers=1024]
   * @param {number} [opts.maxBytes=65536] - largest message sealed or opened
   * @param {{ isRevoked: Function }} [opts.revocations] - the store `receiveRevocation()` feeds
   * @param {(statement: object) => void} [opts.onRotate] - called with each new statement after the first
   */
  constructor({ identity, now = Date.now, lifetimeMs = DEFAULT_STATEMENT_LIFETIME_MS, rotationMs = DEFAULT_ROTATION_MS, maxPeers = 1024, maxBytes = DEFAULT_MAX_SEALED_MESSAGE_BYTES, revocations, onRotate }) {
    if (!identity) throw new TypeError('SealingKeys: identity is required')
    if (rotationMs >= lifetimeMs) throw new RangeError('SealingKeys: rotationMs must be shorter than lifetimeMs, so there is always a valid statement')
    this.#identity = identity
    this.#now = now
    this.#lifetimeMs = lifetimeMs
    this.#rotationMs = rotationMs
    this.#maxPeers = maxPeers
    this.#maxBytes = maxBytes
    this.#revocations = revocations
    this.#onRotate = onRotate
    /** Resolves once the first statement exists (or, in an environment without X25519, once that is known: `supported` is false). */
    this.ready = (HAS_KEY_AGREEMENT ? this.#rotate(false) : Promise.reject(new Error('the installed browsermesh-primitives has no key statements')))
      .catch((err) => { this.#unsupported = err })
  }

  #unsupported = null

  /** False when this environment could not make an agreement key: nothing is sealed or opened then. */
  get supported() { return this.#unsupported === null }

  /** Whether this environment can seal at all. */
  static supported() { return HAS_KEY_AGREEMENT ? supportsKeyAgreement() : Promise.resolve(false) }

  async #rotate(announce) {
    const now = this.#now()
    const pair = await generateAgreementKeyPair()
    const statement = await createKeyStatement(this.#identity, pair, { now, lifetimeMs: this.#lifetimeMs })
    this.#held.set(statement.kid, { pair, notAfter: statement.notAfter })
    this.#current = { pair, statement, createdAt: now }
    if (announce) this.#onRotate?.(statement)
  }

  #purge() {
    const now = this.#now()
    for (const [kid, k] of this.#held) if (now >= k.notAfter) this.#held.delete(kid)
  }

  /** The statement to hand out. Rotates first when it is due. */
  async statement() {
    await this.ready
    if (this.#unsupported) return null
    if (this.#now() - this.#current.createdAt >= this.#rotationMs) {
      // One rotation at a time: later callers wait for it.
      this.ready = this.ready.then(() => (this.#now() - this.#current.createdAt >= this.#rotationMs ? this.#rotate(true) : undefined))
      await this.ready
    }
    this.#purge()
    return this.#current.statement
  }

  /**
   * Verify a statement received from anywhere and remember it. Throws `KeyAgreementError` when it is not
   * good; a good one for a pod already known replaces the old one only if it is newer.
   *
   * @param {object} statement
   * @returns {Promise<{ podId: string, kid: string, notAfter: number }>}
   */
  async learn(statement) {
    const verified = await verifyKeyStatement(statement, { now: this.#now(), revocations: this.#revocations })
    const known = this.#peers.get(verified.podId)
    if (!known || verified.notBefore >= known.verified.notBefore) {
      this.#peers.delete(verified.podId)
      this.#peers.set(verified.podId, { verified, statement })
      while (this.#peers.size > this.#maxPeers) this.#peers.delete(this.#peers.keys().next().value)
    }
    return { podId: verified.podId, kid: verified.kid, notAfter: verified.notAfter }
  }

  /** The verified statement for a pod if it has one that has not expired, else null (synchronous). */
  lookup(podId) {
    if (this.#unsupported) return null
    const k = this.#peers.get(podId)
    if (!k) return null
    if (this.#now() >= k.verified.notAfter) { this.#peers.delete(podId); return null }
    return k.statement
  }

  /** Forget a pod's statement (for instance because it was retired). */
  forget(podId) { this.#peers.delete(podId) }

  /**
   * Seal `message` (any JSON value) to `podId`, for the routed message `id` from this pod.
   * @returns {Promise<object>} the sealed box
   */
  async seal(podId, { from, to, id, message }) {
    const k = this.#peers.get(podId)
    if (!k || this.#now() >= k.verified.notAfter) throw new Error('no current key statement')
    const json = JSON.stringify(message)
    if (json === undefined) throw new TypeError('the message is not JSON')
    return sealToStatement(k.verified, { aad: headerBytes(from, to, id), plaintext: enc.encode(json), maxBytes: this.#maxBytes })
  }

  /** Open a sealed box addressed to this pod; resolves the message. Throws if it does not open. */
  async open({ from, to, id, sealed }) {
    await this.ready
    if (this.#unsupported) throw new Error('sealing is not supported here')
    this.#purge()
    const plain = await openSealed(sealed, { privateKeys: (kid) => this.#held.get(kid)?.pair, aad: headerBytes(from, to, id), maxBytes: this.#maxBytes })
    return JSON.parse(dec.decode(plain))
  }

  /** The largest message that will be sealed. */
  get maxBytes() { return this.#maxBytes }
}
