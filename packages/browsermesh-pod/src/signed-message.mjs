/**
 * signed-message.mjs -- sender authenticity for pod messages.
 *
 * A receiver never takes a sender's identity from a field that the sender
 * or a relay wrote. A signed message carries the sender's public key (`pk`)
 * and a signature (`sig`) by that key over a canonical encoding of the whole
 * message, so a receiver checks two things: that `from` equals the pod id
 * derived from `pk` (pod id = base64url(SHA-256(raw public key))), and that
 * `sig` verifies under `pk`. A pod id therefore needs no prior key exchange.
 *
 * Signed bytes: `"browsermesh/pod-message/v1\n"` followed by the canonical
 * JSON (keys sorted, no whitespace) of an object holding exactly the fields
 * listed in `SIGNED_FIELDS` for the message type: sender, recipient, type,
 * body, `sid` (a random session id for this sender, chosen at boot), `seq`
 * (a counter that increases by one per message within that session) and
 * `ts`. A relay that rewrites, re-addresses or adds to a message invalidates
 * the signature; fields outside the list are never delivered.
 *
 * Freshness: `(sid, seq)` is the message id, and the receiver keeps a sliding
 * window of the last `REPLAY_WINDOW` sequence numbers per sender session, so
 * a copy of a message already accepted is refused and mild reordering is
 * tolerated. Clocks are not trusted: `ts` is signed (so it cannot be
 * changed) but never used to decide freshness. The window state is in memory
 * and bounded (`maxSessionsPerSender` sessions for each of `maxSenders`
 * senders): a copy of a message from a session the receiver has forgotten, or
 * sent to a receiver that restarted, is not recognised as a replay. Links
 * that authenticate the peer themselves (see `Pod`) do not rely on this.
 *
 * Browser-safe: WebCrypto only.
 */

import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import {
  POD_MESSAGE, POD_RPC_REQUEST, POD_RPC_RESPONSE,
  POD_HELLO, POD_HELLO_ACK, POD_GOODBYE,
} from './messages.mjs'

export const SIGNATURE_DOMAIN = 'browsermesh/pod-message/v1\n'

/** Number of sequence numbers behind the highest seen that are still accepted (once each). */
export const REPLAY_WINDOW = 64

/**
 * Fields covered by the signature, per message type. Anything else on a received message is ignored.
 *
 * The discovery messages name their sender `podId` (not `from`), so that is the field a
 * receiver checks against the signing key. `to` on a hello or goodbye is optional: absent
 * (or `'*'`) means "everyone", and when present it is signed like the rest.
 */
export const SIGNED_FIELDS = Object.freeze({
  [POD_MESSAGE]: Object.freeze(['type', 'from', 'to', 'payload', 'ts', 'pk', 'sid', 'seq']),
  [POD_RPC_REQUEST]: Object.freeze(['type', 'from', 'to', 'method', 'params', 'requestId', 'ts', 'pk', 'sid', 'seq']),
  [POD_RPC_RESPONSE]: Object.freeze(['type', 'from', 'to', 'requestId', 'result', 'error', 'ts', 'pk', 'sid', 'seq']),
  [POD_HELLO]: Object.freeze(['type', 'podId', 'kind', 'capabilities', 'to', 'ts', 'pk', 'sid', 'seq']),
  [POD_HELLO_ACK]: Object.freeze(['type', 'podId', 'kind', 'targetPodId', 'ts', 'pk', 'sid', 'seq']),
  [POD_GOODBYE]: Object.freeze(['type', 'podId', 'to', 'ts', 'pk', 'sid', 'seq']),
})

/** The field that names the sender, per message type. */
const SENDER_FIELD = Object.freeze({
  [POD_HELLO]: 'podId', [POD_HELLO_ACK]: 'podId', [POD_GOODBYE]: 'podId',
})

/** The discovery message types (`pod:hello`, `pod:hello-ack`, `pod:goodbye`). */
export const DISCOVERY_TYPES = Object.freeze([POD_HELLO, POD_HELLO_ACK, POD_GOODBYE])

/** Why a message was dropped (the `reason` of a drop). */
export const DROP_REASONS = Object.freeze([
  'unsigned', 'malformed', 'sender-mismatch', 'bad-signature', 'replay', 'unsigned-rpc',
])

// ── Encoding helpers ────────────────────────────────────────────

const encoder = new TextEncoder()

/** @param {Uint8Array} bytes @returns {string} */
export function toBase64url(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** @param {string} str @returns {Uint8Array|null} null when not base64url */
export function fromBase64url(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str) || str.length % 4 === 1) return null
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '='))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Canonical JSON: sorted keys, no whitespace, `undefined` members omitted,
 * finite numbers only, plain objects only.
 *
 * @param {*} value
 * @returns {string}
 */
export function canonicalize(value) {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`Cannot canonicalize non-finite number: ${value}`)
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => {
          if (v === undefined) throw new TypeError('Cannot canonicalize undefined array element')
          return canonicalize(v)
        }).join(',')}]`
      }
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) throw new TypeError('Can only canonicalize plain objects')
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`
    }
    default:
      throw new TypeError(`Cannot canonicalize value of type ${typeof value}`)
  }
}

/**
 * The bytes that are signed for a message: domain prefix plus the canonical
 * JSON of its signed fields except `sig`.
 *
 * @param {object} msg
 * @returns {Uint8Array}
 */
export function signedBytes(msg) {
  const fields = SIGNED_FIELDS[msg.type]
  if (!fields) throw new TypeError(`Not a signable message type: ${msg.type}`)
  const body = {}
  for (const f of fields) if (msg[f] !== undefined) body[f] = msg[f]
  return encoder.encode(SIGNATURE_DOMAIN + canonicalize(body))
}

/** @param {Uint8Array} raw public key @returns {Promise<string>} pod id */
export async function podIdOfRawKey(raw) {
  return toBase64url(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)))
}

// ── Signing ─────────────────────────────────────────────────────

/**
 * Signs outgoing messages for one pod: owns the session id and counter.
 */
export class MessageSigner {
  #identity
  #sid
  #seq = 0
  #pk = null

  /**
   * @param {{ podId: string, sign: Function, rawPublicKey?: Function }} identity - a `PodIdentity`
   */
  constructor(identity, { sessionId } = {}) {
    this.#identity = identity
    if (sessionId !== undefined) {
      this.#sid = sessionId
    } else {
      const rnd = new Uint8Array(12)
      crypto.getRandomValues(rnd)
      this.#sid = toBase64url(rnd)
    }
  }

  /** Whether `identity` can sign (a `{ podId }` stub cannot). */
  static canSign(identity) {
    return !!identity && typeof identity.sign === 'function' && typeof identity.rawPublicKey === 'function'
  }

  get sessionId() { return this.#sid }

  /**
   * Add `pk`, `sid`, `seq` and `sig` to a message. The sequence number is
   * assigned before anything is awaited, so messages are numbered in the
   * order `sign()` is called.
   *
   * @template {object} T
   * @param {T} msg - one of the factory-built messages (`createMessage()`, ...)
   * @returns {Promise<T & { pk: string, sid: string, seq: number, sig: string }>}
   */
  async sign(msg) {
    const seq = ++this.#seq
    this.#pk ??= toBase64url(await this.#identity.rawPublicKey())
    const full = { ...msg, pk: this.#pk, sid: this.#sid, seq }
    const sig = await this.#identity.sign(signedBytes(full))
    return { ...full, sig: toBase64url(sig) }
  }
}

// ── Replay window ───────────────────────────────────────────────

/** Sliding window over the sequence numbers of one sender session. */
export class ReplayWindow {
  #max = 0
  #seen = new Set()
  #size

  constructor(size = REPLAY_WINDOW) { this.#size = size }

  /**
   * Record `seq` if it is new and inside the window.
   * @param {number} seq
   * @returns {boolean} false for a repeat, a number too far behind, or a non-counter
   */
  accept(seq) {
    if (!Number.isSafeInteger(seq) || seq < 1) return false
    if (seq <= this.#max - this.#size) return false
    if (this.#seen.has(seq)) return false
    this.#seen.add(seq)
    if (seq > this.#max) {
      this.#max = seq
      for (const s of this.#seen) if (s <= this.#max - this.#size) this.#seen.delete(s)
    }
    return true
  }
}

/** Bounded replay state for every sender a pod hears from. */
export class ReplayGuard {
  #senders = new Map()
  #maxSenders
  #maxSessions

  /**
   * @param {{ maxSenders?: number, maxSessionsPerSender?: number }} [opts]
   */
  constructor({ maxSenders = 1024, maxSessionsPerSender = 4 } = {}) {
    this.#maxSenders = maxSenders
    this.#maxSessions = maxSessionsPerSender
  }

  /** Number of senders tracked. */
  get size() { return this.#senders.size }

  /** Record `(from, sid, seq)`; false if it was seen or is outside the window. */
  accept(from, sid, seq) {
    return this.#sessionOf(from, sid, true).accept(seq)
  }

  #sessionOf(from, sid, create) {
    let sessions = this.#senders.get(from)
    if (!sessions) {
      if (!create) return null
      sessions = new Map()
      this.#senders.set(from, sessions)
      if (this.#senders.size > this.#maxSenders) this.#senders.delete(this.#senders.keys().next().value)
    } else {
      // most recently used last
      this.#senders.delete(from)
      this.#senders.set(from, sessions)
    }
    let win = sessions.get(sid)
    if (!win) {
      if (!create) return null
      win = new ReplayWindow()
      sessions.set(sid, win)
      if (sessions.size > this.#maxSessions) sessions.delete(sessions.keys().next().value)
    }
    return win
  }
}

// ── Verification ────────────────────────────────────────────────

/**
 * Verify a received message against its own claims: shape, that `from`
 * equals the pod id of `pk`, the signature, and freshness.
 *
 * On success the returned `message` holds only the signed fields, which is
 * all a receiver should use.
 *
 * @param {object} msg
 * @param {{ guard?: ReplayGuard }} [opts] - pass a guard to also refuse replays (and to record this message)
 * @returns {Promise<{ ok: true, from: string, message: object } | { ok: false, reason: string }>}
 */
export async function verifyMessage(msg, { guard } = {}) {
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'malformed' }
  const fields = SIGNED_FIELDS[msg.type]
  if (!fields) return { ok: false, reason: 'malformed' }
  if (msg.sig === undefined && msg.pk === undefined) return { ok: false, reason: 'unsigned' }
  const discovery = DISCOVERY_TYPES.includes(msg.type)
  const sender = msg[SENDER_FIELD[msg.type] ?? 'from']
  const addressed = discovery
    ? (msg.to === undefined || typeof msg.to === 'string') && (msg.type !== POD_HELLO_ACK || typeof msg.targetPodId === 'string')
    : typeof msg.to === 'string'
  if (typeof sender !== 'string' || !addressed || typeof msg.sid !== 'string'
    || typeof msg.pk !== 'string' || typeof msg.sig !== 'string' || !Number.isSafeInteger(msg.seq)) {
    return { ok: false, reason: 'malformed' }
  }
  const raw = fromBase64url(msg.pk)
  const sig = fromBase64url(msg.sig)
  if (!raw || raw.length !== 32 || !sig || sig.length !== 64) return { ok: false, reason: 'malformed' }

  if ((await podIdOfRawKey(raw)) !== sender) return { ok: false, reason: 'sender-mismatch' }

  let bytes
  try { bytes = signedBytes(msg) } catch { return { ok: false, reason: 'malformed' } }
  let valid = false
  try {
    const key = await crypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify'])
    valid = await PodIdentity.verify(key, sig, bytes)
  } catch { valid = false }
  if (!valid) return { ok: false, reason: 'bad-signature' }

  if (guard && !guard.accept(sender, msg.sid, msg.seq)) return { ok: false, reason: 'replay' }

  const message = {}
  for (const f of fields) if (msg[f] !== undefined) message[f] = msg[f]
  return { ok: true, from: sender, message }
}

/**
 * Decide whether a discovery message (`pod:hello`, `pod:hello-ack`,
 * `pod:goodbye`) is attributable to the pod it names, and say how.
 *
 * - A link that authenticates its peer (`meta.peerId`) fixes the sender: the
 *   message must name that peer, and needs no signature.
 * - Otherwise a signature must verify (the message names the pod whose key
 *   signed it, and is fresh).
 * - An unsigned message from an older peer is admitted only when
 *   `allowUnsigned` is true, and then marked `authenticated: false`.
 *
 * @param {object} msg
 * @param {{ peerId?: string }|undefined} meta
 * @param {{ guard?: ReplayGuard, allowUnsigned?: boolean }} [opts]
 * @returns {Promise<{ ok: true, podId: string, authenticated: boolean, sid: string|null } | { ok: false, reason: string }>}
 */
export async function admitDiscovery(msg, meta, { guard, allowUnsigned = false } = {}) {
  if (!msg || typeof msg !== 'object' || !DISCOVERY_TYPES.includes(msg.type) || typeof msg.podId !== 'string') {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof meta?.peerId === 'string') {
    if (msg.podId !== meta.peerId) return { ok: false, reason: 'sender-mismatch' }
    return { ok: true, podId: msg.podId, authenticated: true, sid: typeof msg.sid === 'string' ? msg.sid : null }
  }
  if (msg.sig !== undefined || msg.pk !== undefined) {
    const verdict = await verifyMessage(msg, { guard })
    if (!verdict.ok) return verdict
    return { ok: true, podId: verdict.from, authenticated: true, sid: msg.sid }
  }
  if (!allowUnsigned) return { ok: false, reason: 'unsigned' }
  return { ok: true, podId: msg.podId, authenticated: false, sid: null }
}
