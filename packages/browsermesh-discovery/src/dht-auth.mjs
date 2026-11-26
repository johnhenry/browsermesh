/**
 * dht-auth.mjs -- proofs that a DHT store comes from the owner of the key (opt-in, item 3 of docs/design/discovery-records.md).
 *
 * A `DHT_STORE` message may carry `auth: { v: 1, w, seq, exp, sig }`: `w` the writer's raw Ed25519 public key
 * (base64url), `seq` a per-key counter, `exp` an absolute expiry in ms since the epoch, and `sig` an Ed25519 signature over
 * `frame("browsermesh-dht-store/1", key, SHA-256(canonical JSON of value), seq, exp)`. The stored value itself is unchanged,
 * so a reader of an older node sees exactly what it always saw. A node with a `storePolicy` (see `DhtNode`) checks the proof
 * and decides who may store under which key; a node without one ignores the field.
 */

export const DHT_STORE_DOMAIN = 'browsermesh-dht-store/1'
const WRITE_KEY_DOMAIN = 'browsermesh-dht/write-key/1'
const WRITE_SEED_DOMAIN = 'browsermesh-dht/write-seed/1'
const PKCS8_ED25519_PREFIX = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20)
const MAX_DEPTH = 32

/** The names a node gives for refusing a store (also the keys of `DhtNode#storeStats.refused`). */
export const DHT_STORE_REFUSALS = Object.freeze([
  'malformed', 'bad-auth', 'expired', 'lifetime-too-long', 'value-too-large', 'rate-limited', 'owned-key', 'stale-seq',
  'not-key-owner', 'unsigned-store', 'writer-quota', 'store-full',
])

export class DhtAuthError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'DhtAuthError'
    this.code = code
  }
}

const te = new TextEncoder()
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
function frame(...parts) {
  const chunks = parts.map((p) => (typeof p === 'string' ? te.encode(p) : p))
  const out = new Uint8Array(chunks.reduce((n, c) => n + 4 + c.length, 0))
  let at = 0
  for (const c of chunks) { out.set(u32(c.length), at); at += 4; out.set(c, at); at += c.length }
  return out
}

export function toBase64Url(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
const B64U_RE = /^[A-Za-z0-9_-]*$/
export function fromBase64Url(str) {
  if (typeof str !== 'string' || !B64U_RE.test(str) || str.length % 4 === 1) throw new TypeError('not base64url')
  const bin = atob(str.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (str.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Deterministic JSON: object keys sorted, no whitespace. Throws `DhtAuthError('not-canonical')` for anything JSON cannot carry
 * (undefined, functions, symbols, bigint, non-finite numbers, cycles, more than 32 levels of nesting).
 * @param {*} value
 * @returns {string}
 */
export function canonicalJson(value) {
  const walk = (v, depth) => {
    if (depth > MAX_DEPTH) throw new DhtAuthError('not-canonical', 'canonical JSON: nested too deeply (or cyclic)')
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v)
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new DhtAuthError('not-canonical', 'canonical JSON: non-finite number')
      return JSON.stringify(v)
    }
    if (Array.isArray(v)) return `[${v.map((x) => walk(x, depth + 1)).join(',')}]`
    if (typeof v === 'object') {
      const keys = Object.keys(v).sort()
      return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(v[k], depth + 1)}`).join(',')}}`
    }
    throw new DhtAuthError('not-canonical', `canonical JSON: cannot carry a ${typeof v}`)
  }
  return walk(value, 0)
}

/**
 * The bytes a store proof signs.
 * @param {{ key: string, value: *, seq: number, exp: number }} p
 * @returns {Promise<Uint8Array>}
 */
export async function dhtStoreSigningBytes({ key, value, seq, exp }) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(canonicalJson(value))))
  return frame(DHT_STORE_DOMAIN, key, digest, String(seq), String(exp))
}

/**
 * Sign a store: returns the `auth` object to put on a `DHT_STORE` message (or pass as `store(key, value, ttl, { auth })`).
 * @param {{ signer: { rawPublicKey(): Promise<ArrayBuffer|Uint8Array>, sign(bytes: Uint8Array): Promise<ArrayBuffer|Uint8Array> }, key: string, value: *, seq: number, exp: number }} p
 */
export async function signDhtStore({ signer, key, value, seq, exp }) {
  if (!signer || typeof signer.sign !== 'function' || typeof signer.rawPublicKey !== 'function') throw new DhtAuthError('bad-argument', 'signer must provide rawPublicKey() and sign(bytes)')
  if (typeof key !== 'string' || key === '') throw new DhtAuthError('bad-argument', 'key must be a non-empty string')
  if (!Number.isSafeInteger(seq) || seq < 0) throw new DhtAuthError('bad-argument', 'seq must be a non-negative integer')
  if (!Number.isSafeInteger(exp) || exp <= 0) throw new DhtAuthError('bad-argument', 'exp must be a positive integer (ms since the epoch)')
  const w = toBase64Url(new Uint8Array(await signer.rawPublicKey()))
  const sig = toBase64Url(new Uint8Array(await signer.sign(await dhtStoreSigningBytes({ key, value, seq, exp }))))
  return { v: 1, w, seq, exp, sig }
}

/** Whether `auth` has the shape of a store proof (no cryptography). */
export function isDhtAuth(auth) {
  return auth !== null && typeof auth === 'object' && auth.v === 1 && typeof auth.w === 'string' && auth.w.length === 43 && B64U_RE.test(auth.w)
    && typeof auth.sig === 'string' && auth.sig.length === 86 && B64U_RE.test(auth.sig)
    && Number.isSafeInteger(auth.seq) && auth.seq >= 0 && Number.isSafeInteger(auth.exp) && auth.exp > 0
}

const imported = new Map()
async function verifyKeyOf(w) {
  let key = imported.get(w)
  if (!key) {
    key = await crypto.subtle.importKey('raw', fromBase64Url(w), { name: 'Ed25519' }, false, ['verify'])
    if (imported.size >= 256) imported.clear()
    imported.set(w, key)
  }
  return key
}

/**
 * Check a store proof against the key and value it travels with. Never throws: a bad shape, signature or value is `false`.
 * @param {{ key: string, value: *, auth: object }} p
 * @returns {Promise<boolean>}
 */
export async function verifyDhtStore({ key, value, auth }) {
  try {
    if (!isDhtAuth(auth) || typeof key !== 'string') return false
    const bytes = await dhtStoreSigningBytes({ key, value, seq: auth.seq, exp: auth.exp })
    return await crypto.subtle.verify('Ed25519', await verifyKeyOf(auth.w), fromBase64Url(auth.sig), bytes)
  } catch { return false }
}

/** The pod id a raw (or base64url) Ed25519 public key has: base64url SHA-256 of the raw key. */
export async function podIdOfPublicKey(raw) {
  const bytes = typeof raw === 'string' ? fromBase64Url(raw) : raw
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

const POD_KEY_RE = /^[A-Za-z0-9_-]{43}$/
const ANON_KEY_RE = /^[0-9a-f]{64}$/
const STEALTH_PLAIN_RE = /^stealth:([^:]+):shard3:\d+$/

/**
 * What a DHT key looks like: `pod` (the shape of a pod id), `stealth-plain` (`stealth:<id>:shard3:<n>`), `anon` (64 lowercase hex
 * characters, the agent-anonymous shard keys) or `other`.
 * @param {string} key
 * @returns {'pod'|'stealth-plain'|'anon'|'other'}
 */
export function classifyStoreKey(key) {
  if (typeof key !== 'string') return 'other'
  if (ANON_KEY_RE.test(key)) return 'anon'
  if (POD_KEY_RE.test(key)) return 'pod'
  if (STEALTH_PLAIN_RE.test(key)) return 'stealth-plain'
  return 'other'
}

/** The agent id inside a `stealth:<id>:shard3:<n>` key, or null. */
export function stealthPlainId(key) {
  return STEALTH_PLAIN_RE.exec(key)?.[1] ?? null
}
export const looksLikePodId = (s) => typeof s === 'string' && POD_KEY_RE.test(s)

/**
 * The per-record writer key of an agent-anonymous shard: an Ed25519 key whose seed is `SHA-256(domain, identity.sign(domain,
 * lookupNonce, index))`. An Ed25519 signature is deterministic and only the identity can make it, so the agent re-derives the key
 * whenever it writes, nobody who merely holds the nonce can, and the public keys of one agent's shards are unrelated to each
 * other and to the identity key. Needs a deterministic signer (checked: two signatures of the same bytes must be equal).
 *
 * @param {{ identity: { sign(bytes: Uint8Array): Promise<ArrayBuffer|Uint8Array> }, lookupNonce: string, index: number }} p
 * @returns {Promise<{ rawPublicKey(): Promise<Uint8Array>, sign(bytes: Uint8Array): Promise<Uint8Array> }>}
 */
export async function deriveWriteSigner({ identity, lookupNonce, index }) {
  if (!identity || typeof identity.sign !== 'function') throw new DhtAuthError('bad-argument', 'identity must provide sign(bytes)')
  if (typeof lookupNonce !== 'string' || lookupNonce === '') throw new DhtAuthError('bad-argument', 'lookupNonce is required')
  const message = frame(WRITE_KEY_DOMAIN, lookupNonce, String(index))
  const a = new Uint8Array(await identity.sign(message))
  const b = new Uint8Array(await identity.sign(message))
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) throw new DhtAuthError('identity-not-deterministic', 'owned stores under anonymous keys need an identity whose signatures are deterministic (Ed25519)')
  const seed = new Uint8Array(await crypto.subtle.digest('SHA-256', frame(WRITE_SEED_DOMAIN, a)))
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32)
  pkcs8.set(PKCS8_ED25519_PREFIX)
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length)
  const priv = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'])
  const pub = fromBase64Url((await crypto.subtle.exportKey('jwk', priv)).x)
  seed.fill(0)
  pkcs8.fill(0)
  return {
    rawPublicKey: async () => Uint8Array.from(pub),
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign('Ed25519', priv, bytes)),
  }
}
