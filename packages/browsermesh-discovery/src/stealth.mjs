/**
// STATUS: INTEGRATED — wired into Pod (@johnhenry/browsermesh-pod) lifecycle, proven via E2E testing
 * stealth.mjs -- Agent state sharding across the DHT.
 *
 * NOT ENCRYPTED, NOT ANONYMOUS. This module splits a state string into
 * `threshold` plaintext data shards plus `total - threshold` XOR parity shards
 * and stores them in the DHT under keys derived from the agent id
 * (`stealth:<agentId>:shard:<i>`). It gives availability, not secrecy:
 *
 *   - shard data is the state itself (data shards) or the XOR of it (parity);
 *     anyone who can read the DHT entries can read the state;
 *   - the parity shards are all identical (the XOR of every data chunk), so
 *     the scheme survives the loss of exactly ONE data shard, not `total -
 *     threshold`;
 *   - the shard checksum is a sum of char codes: it catches corruption, not
 *     tampering. (Opt in to shard format 3, `shardFormat: 3`, for a SHA-256
 *     checksum and Reed-Solomon parity that survives any `total - threshold`
 *     lost shards; format 3 lives under different DHT keys, so older peers
 *     are unaffected: docs/design/discovery-records.md.)
 *   - keys name the agent they belong to.
 *
 * For secrecy use the opt-in encrypted path: derive a per-group AES-256-GCM key
 * with `deriveStealthKey(groupSecret, groupId)` and call
 * `StealthAgent#hideEncrypted()` / `#reconstituteEncrypted()` (async). The
 * state is sealed before sharding, bound to the agent id, so shard holders see
 * only ciphertext. That is the first half of #230; threshold sharing of the
 * key is `stealth-threshold.mjs` (opt-in; the signed shards and agent-anonymous DHT keys below
 * came with #230).
 * The plain synchronous `hide()` / `reconstitute()` are unchanged and plaintext.
 *
 * With a `StealthKeyring` (`keyring` option) the sealed state uses the v2
 * envelope: key id (so keys rotate), sequence number and issue time (so an
 * older state is refused as replayed), all authenticated with the sender and
 * type as AES-GCM associated data. Peers without the key get a quiet,
 * counted failure from `tryReconstituteEncrypted()`.
 *
 * Signed shards and anonymous keys (opt-in, with an `identity`): every stored shard is
 * signed with the agent's Ed25519 identity over the agent, the DHT key it lives
 * under, its index, the write's sequence number, its content and the lookup nonce,
 * and every shard read is verified before use (`hideSigned()` / `reconstituteSigned()`,
 * and `hideEncrypted()` / `reconstituteEncrypted()` do the same): a shard that does not
 * verify, is unsigned (unless `allowUnsigned`), or belongs to an older write is refused
 * and counted. With a `lookupNonce` the DHT keys are hex(SHA-256(agentId, nonce, index)) and the
 * records carry no agent id or key, so a DHT observer cannot name the agent from a key or a
 * record. Threshold sharing of the group secret is separate and opt-in (`stealth-threshold.mjs`,
 * docs/design/stealth-threshold.md).
 *
 * What it hides, and from whom: the CONTENT of the state from whoever holds
 * the DHT shards (shard-holding nodes and relays). It does NOT hide that an
 * agent exists (keys are `stealth:<agentId>:shard:<i>`), how large its state
 * is, when it is written or read, or who reads it (traffic analysis). Every
 * holder of the group key can read and forge state: the sender in the
 * associated data is a label, not a signature. To avoid one member holding the whole
 * secret, deal it t-of-n (docs/design/stealth-threshold.md, `stealth-threshold.mjs`).
 *
 * StateShard represents one fragment.
 * ShardDistributor scatters shards across DHT nodes.
 * ShardCollector retrieves and reconstructs state from DHT.
 * StealthAgent orchestrates the hide/reconstitute lifecycle.
 *
 * StateShard represents an erasure-coded fragment.
 * ShardDistributor scatters shards across DHT nodes.
 * ShardCollector retrieves and reconstructs state from DHT.
 * StealthAgent orchestrates the hide/reconstitute lifecycle.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   cd packages/browsermesh-discovery && node --import ./test/_setup-globals.mjs --test test/dht.test.mjs
 */
import {
  stealthShardChecksum, isChecksum3, splitState3, joinState3, shardBytes, toBase64Url as bytesToB64u, fromBase64Url as strictFromB64u,
  MAX_STATE_BYTES, MAX_SHARDS, PARITY_CODES,
} from './shard-format.mjs'

export { stealthShardChecksum }

// ---------------------------------------------------------------------------
// Payload encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

const ENC_PREFIX = 'v1.'
const IV_BYTES = 12

function toBase64Url(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Derive the AES-256-GCM key for one discovery group from a secret every group
 * member holds (HKDF-SHA-256, `groupId` as salt). Members of the same group
 * derive the same key; another group, or a different secret, cannot.
 *
 * @param {Uint8Array|string} groupSecret - At least 16 bytes of shared secret
 * @param {string} groupId
 * @returns {Promise<CryptoKey>}
 */
export async function deriveStealthKey(groupSecret, groupId) {
  if (!groupId || typeof groupId !== 'string') throw new Error('groupId is required and must be a non-empty string')
  const raw = typeof groupSecret === 'string' ? new TextEncoder().encode(groupSecret) : groupSecret
  if (!(raw instanceof Uint8Array) || raw.length < 16) throw new Error('groupSecret must be at least 16 bytes')
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(`browsermesh-stealth:${groupId}`), info: new TextEncoder().encode('aes-256-gcm') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * The secret nonce that makes an agent's DHT keys unguessable (`lookupNonce`
 * of `StealthAgent`), derived from the group secret so every member who holds
 * it can find the shards without anything extra being stored (HKDF-SHA-256,
 * `agentId` and `epoch` in the salt/info). Change `epoch` to move an agent's shards
 * to new keys (for example when a member leaves). Anyone who holds the group
 * secret can compute it; anyone who does not cannot.
 *
 * @param {Uint8Array|string} groupSecret - At least 16 bytes of shared secret
 * @param {string} agentId
 * @param {number} [epoch=0]
 * @returns {Promise<string>} base64url, 22 characters (16 bytes)
 */
export async function deriveStealthLookupNonce(groupSecret, agentId, epoch = 0) {
  if (!agentId || typeof agentId !== 'string') throw new Error('agentId is required and must be a non-empty string')
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('epoch must be a non-negative integer')
  const raw = typeof groupSecret === 'string' ? new TextEncoder().encode(groupSecret) : groupSecret
  if (!(raw instanceof Uint8Array) || raw.length < 16) throw new Error('groupSecret must be at least 16 bytes')
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('browsermesh-stealth/lookup-nonce/1'),
      info: new TextEncoder().encode(`${epoch}\0${agentId}`),
    },
    base,
    128,
  )
  return toBase64Url(new Uint8Array(bits))
}

const LOOKUP_NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/
const SHARD_DOMAIN = 'browsermesh-stealth-shard/1'
const SHARD_DOMAIN_3 = 'browsermesh-stealth-shard/3'
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
async function sha256Hex(text) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
}

/**
 * Seal a state string: `v1.` + base64url(iv || ciphertext+tag), a fresh random
 * IV per call, `agentId` as additional authenticated data.
 *
 * @param {string} state
 * @param {CryptoKey} key
 * @param {string} agentId
 * @returns {Promise<string>}
 */
export async function encryptStealthState(state, key, agentId) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(agentId) },
    key,
    new TextEncoder().encode(state),
  ))
  const out = new Uint8Array(IV_BYTES + ct.length)
  out.set(iv, 0)
  out.set(ct, IV_BYTES)
  return ENC_PREFIX + toBase64Url(out)
}

/**
 * Open a payload produced by `encryptStealthState`. Rejects on a wrong key,
 * wrong agent id, or any modification.
 *
 * @param {string} payload
 * @param {CryptoKey} key
 * @param {string} agentId
 * @returns {Promise<string>}
 */
export async function decryptStealthState(payload, key, agentId) {
  if (typeof payload !== 'string' || !payload.startsWith(ENC_PREFIX)) throw new Error('not an encrypted stealth payload')
  const bytes = fromBase64Url(payload.slice(ENC_PREFIX.length))
  if (bytes.length <= IV_BYTES) throw new Error('encrypted stealth payload is truncated')
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: new TextEncoder().encode(agentId) },
    key,
    bytes.slice(IV_BYTES),
  )
  return new TextDecoder().decode(pt)
}

// ---------------------------------------------------------------------------
// Keyed, versioned, replay-bounded sealing (v2 envelope)
// ---------------------------------------------------------------------------

/**
 * Error for every sealing/opening refusal; `code` says why:
 * `not-encrypted | malformed | unknown-key | tampered | replayed | stale |
 * key-exhausted | no-key | bad-argument`.
 */
export class StealthError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StealthError'
    this.code = code
  }
}

const V2_PREFIX = 'v2.'
const V2_DOMAIN = 'browsermesh-stealth/v2'
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const DEFAULT_MAX_SEALS_PER_KEY = 2 ** 32 // NIST SP 800-38D bound for random 96-bit IVs

/**
 * A set of AES-256-GCM keys identified by id, one of them current. Sealing
 * uses the current key and writes its id into the envelope; opening picks the
 * key by that id, so keys can rotate: add the new key, make it current, keep
 * the old one until nothing sealed under it matters, then `remove` it.
 * Each key counts its seals and refuses past `maxSealsPerKey` (random 96-bit
 * IVs are only safe for a bounded number of messages per key).
 */
export class StealthKeyring {
  #keys = new Map()
  #current = null
  #groupId = null
  #max

  /** @param {{ maxSealsPerKey?: number, groupId?: string }} [opts] */
  constructor({ maxSealsPerKey = DEFAULT_MAX_SEALS_PER_KEY, groupId = null } = {}) {
    if (!Number.isInteger(maxSealsPerKey) || maxSealsPerKey < 1) throw new StealthError('bad-argument', 'maxSealsPerKey must be a positive integer')
    this.#max = maxSealsPerKey
    this.#groupId = groupId
  }

  /**
   * Build a keyring from group secrets (HKDF per `deriveStealthKey`).
   *
   * @param {string} groupId
   * @param {{ id: string, secret: Uint8Array|string }[]} entries
   * @param {string} [currentId] - Defaults to the last entry
   * @param {{ maxSealsPerKey?: number }} [opts]
   * @returns {Promise<StealthKeyring>}
   */
  static async fromGroupSecrets(groupId, entries, currentId, opts = {}) {
    if (!Array.isArray(entries) || entries.length === 0) throw new StealthError('bad-argument', 'at least one key is required')
    const kr = new StealthKeyring({ ...opts, groupId })
    for (const e of entries) await kr.add(e.id, e.secret, { makeCurrent: false })
    kr.setCurrent(currentId ?? entries[entries.length - 1].id)
    return kr
  }

  /** Derive and add a key from a group secret. */
  async add(id, secret, { groupId = this.#groupId, makeCurrent = false } = {}) {
    if (!groupId) throw new StealthError('bad-argument', 'groupId is required to derive a key')
    return this.addKey(id, await deriveStealthKey(secret, groupId), { makeCurrent })
  }

  /** Add an existing AES-GCM `CryptoKey` under `id`. */
  addKey(id, key, { makeCurrent = false } = {}) {
    if (typeof id !== 'string' || !KEY_ID_RE.test(id)) throw new StealthError('bad-argument', 'key id must be 1-64 characters of A-Z a-z 0-9 _ -')
    this.#keys.set(id, { key, seals: 0 })
    if (makeCurrent || this.#current === null) this.#current = id
    return this
  }

  setCurrent(id) {
    if (!this.#keys.has(id)) throw new StealthError('unknown-key', `no key ${id}`)
    this.#current = id
  }

  /** Drop a key. The current key cannot be removed: make another current first. */
  remove(id) {
    if (id === this.#current) throw new StealthError('bad-argument', 'cannot remove the current key')
    return this.#keys.delete(id)
  }

  has(id) { return this.#keys.has(id) }
  get currentId() { return this.#current }
  get ids() { return [...this.#keys.keys()] }

  /** @private used by sealStealthMessage */
  _useCurrent() {
    const e = this.#keys.get(this.#current)
    if (!e) throw new StealthError('no-key', 'the keyring has no key')
    if (e.seals >= this.#max) throw new StealthError('key-exhausted', `key ${this.#current} reached its message budget; rotate it`)
    e.seals++
    return { id: this.#current, key: e.key }
  }

  /** @private used by openStealthMessage */
  _get(id) { return this.#keys.get(id)?.key ?? null }
}

function u32(n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]) }
function u64(n) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b }

/** Associated data: length-prefixed domain, type, sender, key id, then seq and issuedAt. */
function v2Aad(type, sender, keyId, seq, issuedAt) {
  const te = new TextEncoder()
  const parts = [V2_DOMAIN, type, sender, keyId].map((s) => te.encode(s))
  const out = []
  for (const p of parts) out.push(u32(p.length), p)
  out.push(u64(seq), u64(issuedAt))
  const n = out.reduce((a, p) => a + p.length, 0)
  const buf = new Uint8Array(n)
  let o = 0
  for (const p of out) { buf.set(p, o); o += p.length }
  return buf
}

/**
 * Seal a message for a group that shares a keyring: AES-256-GCM, a fresh
 * random 96-bit nonce per message, the key id, sequence number and issue time
 * carried in the envelope and authenticated together with the sender and
 * message type as associated data. Envelope:
 * `v2.<keyId>.<seq>.<issuedAt>.<base64url(iv || ciphertext+tag)>`.
 *
 * The associated data binds the sender and type as LABELS: every group member
 * holds the key and can seal under any sender name. It is not a signature.
 *
 * @param {string} plaintext
 * @param {{ keyring: StealthKeyring, sender: string, type: string, seq?: number, issuedAt?: number }} opts
 * @returns {Promise<string>}
 */
export async function sealStealthMessage(plaintext, { keyring, sender, type, seq, issuedAt }) {
  if (!keyring || typeof keyring._useCurrent !== 'function') throw new StealthError('no-key', 'a keyring is required')
  if (!sender || typeof sender !== 'string' || !type || typeof type !== 'string') throw new StealthError('bad-argument', 'sender and type are required strings')
  const now = Date.now()
  seq = seq ?? now
  issuedAt = issuedAt ?? now
  if (!Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new StealthError('bad-argument', 'seq and issuedAt must be non-negative integers')
  const { id, key } = keyring._useCurrent()
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: v2Aad(type, sender, id, seq, issuedAt) },
    key,
    new TextEncoder().encode(plaintext),
  ))
  const body = new Uint8Array(IV_BYTES + ct.length)
  body.set(iv, 0)
  body.set(ct, IV_BYTES)
  return `${V2_PREFIX}${id}.${seq}.${issuedAt}.${toBase64Url(body)}`
}

/**
 * Open a v2 envelope. Refusals throw `StealthError`: `not-encrypted` (not a v2
 * envelope), `malformed`, `unknown-key` (key id not in the keyring),
 * `tampered` (wrong key, or any change to the ciphertext, sender, type, key id,
 * seq or issue time), then, after authentication, `replayed` (`seq <
 * minSeq`) and `stale` (`now - issuedAt > maxAgeMs`).
 *
 * @param {string} payload
 * @param {{ keyring: StealthKeyring, sender: string, type: string, minSeq?: number, maxAgeMs?: number, now?: number }} opts
 * @returns {Promise<{ plaintext: string, keyId: string, seq: number, issuedAt: number }>}
 */
export async function openStealthMessage(payload, { keyring, sender, type, minSeq, maxAgeMs, now }) {
  if (typeof payload !== 'string' || !payload.startsWith(V2_PREFIX)) throw new StealthError('not-encrypted', 'not a v2 stealth envelope')
  const parts = payload.split('.')
  if (parts.length !== 5 || !KEY_ID_RE.test(parts[1]) || !/^\d{1,16}$/.test(parts[2]) || !/^\d{1,16}$/.test(parts[3])) {
    throw new StealthError('malformed', 'malformed stealth envelope')
  }
  const [, keyId, seqS, issuedS, bodyS] = parts
  const seq = Number(seqS)
  const issuedAt = Number(issuedS)
  const key = keyring?._get?.(keyId)
  if (!key) throw new StealthError('unknown-key', `no key ${keyId}`)
  let bytes
  try { bytes = fromBase64Url(bodyS) } catch { throw new StealthError('malformed', 'malformed stealth envelope') }
  if (bytes.length <= IV_BYTES) throw new StealthError('malformed', 'truncated stealth envelope')
  let pt
  try {
    pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: v2Aad(type, sender, keyId, seq, issuedAt) },
      key,
      bytes.slice(IV_BYTES),
    )
  } catch {
    throw new StealthError('tampered', 'authentication failed')
  }
  if (minSeq !== undefined && seq < minSeq) throw new StealthError('replayed', 'older than the newest state already seen')
  if (maxAgeMs !== undefined && (now ?? Date.now()) - issuedAt > maxAgeMs) throw new StealthError('stale', 'older than the allowed age')
  return { plaintext: new TextDecoder().decode(pt), keyId, seq, issuedAt }
}

// ---------------------------------------------------------------------------
// Checksum Helper
// ---------------------------------------------------------------------------

/**
 * Simple checksum: sum of char codes mod 2^32.
 * @param {string} data
 * @returns {number}
 */
function simpleChecksum(data) {
  let sum = 0
  for (let i = 0; i < data.length; i++) {
    sum = (sum + data.charCodeAt(i)) >>> 0
  }
  return sum
}

// ---------------------------------------------------------------------------
// StateShard
// ---------------------------------------------------------------------------

/**
 * One fragment of sharded agent state: a plaintext slice of the state (data
 * shard) or the XOR of all slices (parity shard). Not encrypted.
 */
export class StateShard {
  /** @type {string} */
  #shardId

  /** @type {string} */
  #agentId

  /** @type {string} */
  #data

  /** @type {number} */
  #threshold

  /** @type {number} */
  #total

  /** @type {number} */
  #checksum

  /**
   * @param {object} opts
   * @param {string} opts.shardId - Unique shard identifier
   * @param {string} opts.agentId - Agent this shard belongs to
   * @param {string} opts.data - Shard data
   * @param {number} opts.threshold - Minimum shards needed for recovery
   * @param {number} opts.total - Total shards created
   * @param {number} opts.checksum - Checksum of the data
   */
  constructor({ shardId, agentId, data, threshold, total, checksum }) {
    this.#shardId = shardId
    this.#agentId = agentId
    this.#data = data
    this.#threshold = threshold
    this.#total = total
    this.#checksum = checksum
  }

  /** @returns {string} */
  get shardId() { return this.#shardId }

  /** @returns {string} */
  get agentId() { return this.#agentId }

  /** @returns {string} */
  get data() { return this.#data }

  /** @returns {number} */
  get threshold() { return this.#threshold }

  /** @returns {number} */
  get total() { return this.#total }

  /** @returns {number} */
  get checksum() { return this.#checksum }

  /**
   * Verify the shard by recomputing checksum from data.
   * @returns {boolean}
   */
  verify() {
    return simpleChecksum(this.#data) === this.#checksum
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      shardId: this.#shardId,
      agentId: this.#agentId,
      data: this.#data,
      threshold: this.#threshold,
      total: this.#total,
      checksum: this.#checksum,
    }
  }

  /**
   * Re-hydrate from a plain object.
   * @param {object} json
   * @returns {StateShard}
   */
  static fromJSON(json) {
    return new StateShard(json)
  }
}

// ---------------------------------------------------------------------------
// ShardDistributor
// ---------------------------------------------------------------------------

/**
 * Distributes agent state as shards across the DHT.
 */
export class ShardDistributor {
  /** @type {import('./dht.mjs').DhtNode} */
  #dhtNode

  /** @type {number} */
  #threshold

  /** @type {number} */
  #totalShards

  /**
   * @param {object} opts
   * @param {import('./dht.mjs').DhtNode} opts.dhtNode - DHT node for storage
   * @param {number} [opts.threshold=3] - Minimum shards for recovery
   * @param {number} [opts.totalShards=5] - Total shards to create
   */
  constructor({ dhtNode, threshold = 3, totalShards = 5 }) {
    this.#dhtNode = dhtNode
    this.#threshold = threshold
    this.#totalShards = totalShards
  }

  /**
   * Split state into shards without storing them (the signed path stores its own records).
   * @param {string} agentId
   * @param {string} stateBlob
   * @returns {StateShard[]}
   */
  split(agentId, stateBlob) {
    return this.#splitState(agentId, stateBlob, this.#threshold, this.#totalShards)
  }

  /**
   * Distribute agent state as shards into the DHT.
   * @param {string} agentId - Agent identifier
   * @param {string} stateBlob - State data to shard
   * @returns {StateShard[]} Array of created shards
   */
  distribute(agentId, stateBlob) {
    const shards = this.#splitState(agentId, stateBlob, this.#threshold, this.#totalShards)

    // Store each shard in DHT
    const keys = this.#generateShardKeys(agentId, this.#totalShards)
    for (let i = 0; i < shards.length; i++) {
      this.#dhtNode.store(keys[i], shards[i].toJSON())
    }

    return shards
  }

  /**
   * Split state into shards with XOR-based parity.
   *
   * Creates `threshold` data shards by splitting the blob into equal chunks,
   * then creates `total - threshold` parity shards by XOR-ing chunks in rotating fashion.
   *
   * @param {string} agentId
   * @param {string} blob
   * @param {number} threshold
   * @param {number} total
   * @returns {StateShard[]}
   * @private
   */
  #splitState(agentId, blob, threshold, total) {
    const shards = []
    const chunkSize = Math.ceil(blob.length / threshold)

    // Create data shards
    const chunks = []
    for (let i = 0; i < threshold; i++) {
      const start = i * chunkSize
      const chunk = blob.slice(start, start + chunkSize)
      // Pad chunk to chunkSize with null chars for consistent XOR
      const padded = chunk.padEnd(chunkSize, '\0')
      chunks.push(padded)

      const shard = new StateShard({
        shardId: `${agentId}:shard:${i}`,
        agentId,
        data: padded,
        threshold,
        total,
        checksum: simpleChecksum(padded),
      })
      shards.push(shard)
    }

    // Create parity shards by XOR-ing data chunks in rotating fashion
    const parityCount = total - threshold
    for (let p = 0; p < parityCount; p++) {
      let parityData = ''
      for (let c = 0; c < chunkSize; c++) {
        let xorVal = 0
        for (let d = 0; d < threshold; d++) {
          // Rotate: XOR with shifted indices
          const idx = (d + p) % threshold
          xorVal ^= chunks[idx].charCodeAt(c)
        }
        parityData += String.fromCharCode(xorVal)
      }

      const shard = new StateShard({
        shardId: `${agentId}:shard:${threshold + p}`,
        agentId,
        data: parityData,
        threshold,
        total,
        checksum: simpleChecksum(parityData),
      })
      shards.push(shard)
    }

    return shards
  }

  /**
   * Generate deterministic DHT keys for shard storage.
   * @param {string} agentId
   * @param {number} total
   * @returns {string[]}
   * @private
   */
  #generateShardKeys(agentId, total) {
    const keys = []
    for (let i = 0; i < total; i++) {
      keys.push(`stealth:${agentId}:shard:${i}`)
    }
    return keys
  }
}

// ---------------------------------------------------------------------------
// ShardCollector
// ---------------------------------------------------------------------------

/**
 * Collects and reconstructs agent state from DHT shards.
 */
export class ShardCollector {
  /** @type {import('./dht.mjs').DhtNode} */
  #dhtNode

  /** @type {number} */
  #threshold

  /**
   * @param {object} opts
   * @param {import('./dht.mjs').DhtNode} opts.dhtNode - DHT node for retrieval
   * @param {number} [opts.threshold=3] - Minimum shards needed
   */
  constructor({ dhtNode, threshold = 3 }) {
    this.#dhtNode = dhtNode
    this.#threshold = threshold
  }

  /**
   * Collect shards from the DHT for a given agent.
   * @param {string} agentId
   * @param {number} totalShards
   * @returns {StateShard[]} Retrieved shards
   */
  collect(agentId, totalShards) {
    const shards = []
    for (let i = 0; i < totalShards; i++) {
      const key = `stealth:${agentId}:shard:${i}`
      const value = this.#dhtNode.get(key)
      if (value) {
        const shard = value instanceof StateShard ? value : StateShard.fromJSON(value)
        if (shard.verify()) {
          shards.push(shard)
        }
      }
    }
    return shards
  }

  /**
   * Reconstruct the original state from at least `threshold` valid shards.
   *
   * All `threshold` data shards are used when present. If exactly one data
   * shard is missing and a parity shard is available, the missing chunk is
   * recovered as parity XOR the other chunks. Two or more missing data
   * shards cannot be recovered (every parity shard carries the same XOR).
   *
   * @param {StateShard[]} shards - At least `threshold` valid shards
   * @returns {string} Reconstructed state blob
   */
  reconstruct(shards) {
    if (shards.length < this.#threshold) {
      throw new Error(`Need at least ${this.#threshold} shards, got ${shards.length}`)
    }

    // Sort shards by their index to get data shards in order
    const sorted = [...shards].sort((a, b) => {
      const idxA = parseInt(a.shardId.split(':').pop(), 10)
      const idxB = parseInt(b.shardId.split(':').pop(), 10)
      return idxA - idxB
    })

    // Data shards by index; parity shards (index >= threshold) separately
    const byIndex = new Map()
    let parity = null
    for (const s of sorted) {
      const idx = parseInt(s.shardId.split(':').pop(), 10)
      if (idx < this.#threshold) byIndex.set(idx, s.data)
      else if (!parity) parity = s.data
    }

    const missing = []
    for (let i = 0; i < this.#threshold; i++) {
      if (!byIndex.has(i)) missing.push(i)
    }

    if (missing.length > 1 || (missing.length === 1 && parity === null)) {
      throw new Error(
        `Not enough data shards for reconstruction: need ${this.#threshold}, got ${this.#threshold - missing.length}` +
        ' (parity can recover at most one missing data shard)',
      )
    }

    if (missing.length === 1) {
      // parity = XOR of every data chunk, so the missing chunk is parity XOR the rest
      let recovered = ''
      for (let c = 0; c < parity.length; c++) {
        let xorVal = parity.charCodeAt(c)
        for (const data of byIndex.values()) xorVal ^= data.charCodeAt(c)
        recovered += String.fromCharCode(xorVal)
      }
      byIndex.set(missing[0], recovered)
    }

    // Concatenate data chunks in order
    let result = ''
    for (let i = 0; i < this.#threshold; i++) {
      result += byIndex.get(i)
    }

    // Remove null padding
    return result.replace(/\0+$/, '')
  }

  /**
   * Probe how many valid shards are available for an agent.
   * @param {string} agentId
   * @param {number} totalShards
   * @returns {number} Count of available valid shards
   */
  probe(agentId, totalShards) {
    const shards = this.collect(agentId, totalShards)
    return shards.length
  }
}

// ---------------------------------------------------------------------------
// StealthAgent
// ---------------------------------------------------------------------------

/** A shard format option (2, 3 or a non-empty list of them) as a sorted, de-duplicated list. */
function normalizeFormats(value, name) {
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0 || !list.every((f) => f === 2 || f === 3)) throw new StealthError('bad-argument', `${name} must be 2, 3 or a non-empty list of them`)
  return [...new Set(list)].sort((a, b) => a - b)
}

/**
 * Orchestrates the hide/reconstitute lifecycle for an agent's state.
 *
 * State is sharded across the DHT as plaintext data shards plus XOR parity
 * (see the module header): it can be reconstructed from `threshold` shards
 * (so one lost data shard is tolerated) but it is NOT encrypted and the shard
 * keys name the agent. Encrypt the state before `hide()` if it is sensitive.
 *
 * Methods are `hide(stateBlob)`, `reconstitute()`, `isViable()` and
 * `getManifest()`; they are synchronous.
 */
export class StealthAgent {
  /** @type {string} */
  #agentId

  /** @type {import('./dht.mjs').DhtNode} */
  #dhtNode

  /** @type {number} */
  #threshold

  /** @type {number} */
  #totalShards

  /** @type {ShardDistributor} */
  #distributor

  /** @type {ShardCollector} */
  #collector

  /** @type {object|null} */
  #manifest = null

  /** @type {CryptoKey|null} */
  #key = null

  /** @type {StealthKeyring|null} */
  #keyring = null

  #maxAgeMs

  /** Newest sequence number this agent has written. */
  #seq = 0

  /** Newest sequence number this agent has accepted from the DHT. */
  #highestSeen = 0

  #stats = {
    opened: 0, notEncrypted: 0, noKey: 0, unknownKey: 0, tampered: 0,
    replayed: 0, stale: 0, malformed: 0, unavailable: 0,
    shardUnsigned: 0, shardUnsignedAccepted: 0, shardBadSignature: 0, shardStale: 0, shardMalformed: 0, shardCorrupt: 0,
  }

  /** @type {number[]} shard formats this agent writes (2 and/or 3) */
  #writeFormats = [2]

  /** @type {number[]} shard formats this agent reads */
  #readFormats = [2, 3]

  #parity = 'rs'

  /** @type {{ podId: string, rawPublicKey: () => Promise<Uint8Array>, sign: (data: Uint8Array) => Promise<Uint8Array> }|null} */
  #identity = null

  #allowUnsigned = false

  /** @type {Uint8Array[]} raw public keys whose shard signatures are accepted besides this agent's own */
  #trustedKeys = []

  /** @type {string|null} */
  #lookupNonce = null

  #shardSeq = 0

  /** @type {Map<string, CryptoKey>} */
  #verifyKeys = new Map()

  /**
   * @param {object} opts
   * @param {string} opts.agentId - Agent identifier
   * @param {import('./dht.mjs').DhtNode} opts.dhtNode - DHT node
   * @param {number} [opts.threshold=3] - Minimum shards for recovery
   * @param {number} [opts.totalShards=5] - Total shards to create
   * @param {CryptoKey} [opts.key] - AES-GCM key (see `deriveStealthKey`); enables `hideEncrypted()` / `reconstituteEncrypted()`
   * @param {object} [opts.identity] - The agent's identity (a `PodIdentity`, or `{ podId, rawPublicKey(), sign(bytes) }`). With it the agent signs every shard it stores and verifies every shard it reads (`hideSigned()` / `reconstituteSigned()`, and `hideEncrypted()` / `reconstituteEncrypted()` do the same). Such an agent's synchronous `hide()` / `reconstitute()` / `isViable()` throw `async-required` rather than silently write or read unsigned shards.
   * @param {boolean} [opts.allowUnsigned=false] - With an identity: also accept a shard that carries no signature (written by an older peer). Off by default: an unsigned shard is refused and counted (`stats.shardUnsigned`). Accepted ones are counted in `stats.shardUnsignedAccepted`.
   * @param {Uint8Array[]} [opts.trustedKeys] - Raw Ed25519 public keys, besides the agent's own, whose shard signatures are accepted (for example another replica of the same agent).
   * @param {string} [opts.lookupNonce] - A secret nonce (at least 16 base64url characters; see `deriveStealthLookupNonce`). With it, DHT keys are `hex(SHA-256(agentId, nonce, index))`, which do not name the agent, and the stored records carry no agent id. Needs `identity`. Whoever should be able to find the shards must hold the nonce.
   * @param {2|3|Array<2|3>} [opts.shardFormat=2] - Which shard record format(s) this agent WRITES. 2 is the format older peers read (the default, unchanged). 3 adds a SHA-256 checksum and Reed-Solomon parity under key names older peers never read; `[2, 3]` writes both so older readers keep working. Format 3 needs the async methods (`hideAsync`, `hideSigned`, `hideEncrypted`): the synchronous `hide()` throws `async-required` when 3 is selected. See docs/design/discovery-records.md.
   * @param {Array<2|3>} [opts.readFormats=[2, 3]] - Which formats this agent READS. The newest complete valid write across them wins (a tie prefers 3). `[3]` ignores every format-2 record (use once every writer is upgraded, so stale format-2 records cannot be read back).
   * @param {'rs'|'xor'} [opts.parity='rs'] - Format 3 only: the parity code of the shards written. `rs` is Reed-Solomon over GF(2^8) (any `threshold` of `totalShards` rebuild the state); `xor` is the older single-loss parity.
   */
  constructor({ agentId, dhtNode, threshold = 3, totalShards = 5, key = null, keyring = null, maxAgeMs, identity = null, allowUnsigned = false, trustedKeys = [], lookupNonce = null, shardFormat = 2, readFormats = [2, 3], parity = 'rs' }) {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId is required and must be a non-empty string')
    }
    this.#writeFormats = normalizeFormats(shardFormat, 'shardFormat')
    this.#readFormats = normalizeFormats(readFormats, 'readFormats')
    if (!PARITY_CODES.includes(parity)) throw new StealthError('bad-argument', `parity must be one of ${PARITY_CODES.join(', ')}`)
    this.#parity = parity
    if (lookupNonce !== null && (typeof lookupNonce !== 'string' || !LOOKUP_NONCE_RE.test(lookupNonce))) {
      throw new StealthError('bad-argument', 'lookupNonce must be at least 16 base64url characters (see deriveStealthLookupNonce)')
    }
    if (lookupNonce !== null && !identity) throw new StealthError('bad-argument', 'lookupNonce needs an identity: anonymous keys are used on the signed path')
    if (identity && (typeof identity.sign !== 'function' || typeof identity.rawPublicKey !== 'function')) {
      throw new StealthError('bad-argument', 'identity must provide rawPublicKey() and sign(bytes) (a PodIdentity)')
    }
    if (!Array.isArray(trustedKeys) || !trustedKeys.every((k) => k instanceof Uint8Array && k.length === 32)) {
      throw new StealthError('bad-argument', 'trustedKeys must be raw 32-byte Ed25519 public keys')
    }
    this.#identity = identity
    this.#allowUnsigned = allowUnsigned === true
    this.#trustedKeys = trustedKeys.map((k) => new Uint8Array(k))
    this.#lookupNonce = lookupNonce
    this.#key = key
    this.#keyring = keyring
    this.#maxAgeMs = maxAgeMs
    this.#agentId = agentId
    this.#dhtNode = dhtNode
    this.#threshold = threshold
    this.#totalShards = totalShards
    this.#distributor = new ShardDistributor({ dhtNode, threshold, totalShards })
    this.#collector = new ShardCollector({ dhtNode, threshold })
  }

  /**
   * Distribute the agent's state as shards across the DHT. This is sharding,
   * not concealment: the shards are plaintext slices of `stateBlob`.
   * @param {string} stateBlob - State data to hide
   * @returns {object} Manifest with shard keys and metadata
   */
  hide(stateBlob) {
    this.#requireUnsignedAgent()
    if (this.#writeFormats.join() !== '2') throw new StealthError('async-required', 'shard format 3 needs a hash and is written by hideAsync() / hideEncrypted(); hide() writes format 2 only')
    return this.#hideUnsigned(stateBlob)
  }

  /** An agent with an identity signs and verifies: the synchronous paths cannot, so they refuse. */
  #requireUnsignedAgent() {
    if (this.#identity) throw new StealthError('async-required', 'this agent has an identity and signs its shards: use hideSigned() / reconstituteSigned() / isRecoverable() (or the encrypted variants)')
  }

  /**
   * Like `hide()`, but asynchronous: it writes every format in `shardFormat` (so format 3, which needs a hash), and with an
   * `identity` it signs, exactly as `hideSigned()`. The state is plaintext slices unless you seal it first.
   * @param {string} stateBlob
   * @returns {Promise<object>} Manifest
   */
  async hideAsync(stateBlob) {
    return this.#store(stateBlob)
  }

  /**
   * Like `reconstitute()`, but asynchronous and reading every format in `readFormats`; with an `identity` it verifies
   * signatures, exactly as `reconstituteSigned()`.
   * @returns {Promise<string>}
   */
  async reconstituteAsync() {
    return this.#load()
  }

  #hideUnsigned(stateBlob) {
    const shards = this.#distributor.distribute(this.#agentId, stateBlob)

    this.#manifest = {
      agentId: this.#agentId,
      threshold: this.#threshold,
      totalShards: this.#totalShards,
      shardIds: shards.map(s => s.shardId),
      hiddenAt: Date.now(),
    }

    return this.#manifest
  }

  /**
   * Like `hide()`, but seals the state with AES-GCM first, so the DHT holds
   * only ciphertext. Requires the `key` option.
   * @param {string} stateBlob
   * @returns {Promise<object>} Manifest (`encrypted: true`)
   */
  async hideEncrypted(stateBlob) {
    if (this.#keyring) {
      // v2 envelope: key id, sequence number and issue time, authenticated with sender and type
      const seq = Math.max(this.#seq + 1, Date.now())
      const sealed = await sealStealthMessage(stateBlob, { keyring: this.#keyring, sender: this.#agentId, type: 'state', seq })
      this.#seq = seq
      await this.#store(sealed)
      this.#manifest = { ...this.#manifest, encrypted: true, keyId: sealed.split('.')[1], seq }
      return this.#manifest
    }
    if (!this.#key) throw new StealthError('no-key', 'hideEncrypted requires a key or keyring (see deriveStealthKey / StealthKeyring)')
    const sealed = await encryptStealthState(stateBlob, this.#key, this.#agentId)
    await this.#store(sealed)
    this.#manifest = { ...this.#manifest, encrypted: true }
    return this.#manifest
  }

  /** Store a string as shards: signed (and possibly anonymous) with an identity, as before without. */
  async #store(blob) {
    if (this.#identity) return this.#hideSignedNow(blob)
    return this.#hideUnsignedAsync(blob)
  }

  /** Read the stored string back: signature-verified with an identity, as before without. */
  async #load() {
    if (this.#identity) return this.#reconstituteSignedNow()
    return this.#reconstituteUnsignedAsync()
  }

  // -- shard format 3 (checksum + Reed-Solomon parity), unsigned -----------------

  /** Cut `blob` into format-3 shards with their checksums; refuses what format 3 cannot carry. */
  async #makeShards3(blob) {
    if (typeof blob !== 'string' || !blob.isWellFormed()) throw new StealthError('not-well-formed', 'shard format 3 stores UTF-8 text: the state has a lone surrogate')
    if (this.#totalShards > MAX_SHARDS || this.#totalShards < this.#threshold || this.#threshold < 1) {
      throw new StealthError('too-many-shards', `format 3 needs 1 <= threshold <= totalShards <= ${MAX_SHARDS}`)
    }
    if (blob.length > MAX_STATE_BYTES || new TextEncoder().encode(blob).length > MAX_STATE_BYTES) throw new StealthError('state-too-large', `format 3 carries at most ${MAX_STATE_BYTES} bytes of state`)
    const { len, shards } = splitState3(blob, this.#threshold, this.#totalShards, this.#parity)
    const out = []
    for (let i = 0; i < shards.length; i++) {
      const checksum = await stealthShardChecksum({ index: i, threshold: this.#threshold, total: this.#totalShards, code: this.#parity, len, bytes: shards[i] })
      out.push({ i, data: bytesToB64u(shards[i]), checksum })
    }
    return { len, code: this.#parity, shards: out }
  }

  async #hideUnsignedAsync(blob) {
    if (this.#writeFormats.join() === '2') return this.#hideUnsigned(blob)
    const had2 = this.#writeFormats.includes(2)
    if (had2) this.#hideUnsigned(blob)
    const keys3 = await this.#shardKeys(3)
    const made = await this.#makeShards3(blob)
    for (const s of made.shards) {
      this.#dhtNode.store(keys3[s.i], {
        v: 3, shardId: `${this.#agentId}:shard3:${s.i}`, agentId: this.#agentId, i: s.i, data: s.data, threshold: this.#threshold,
        total: this.#totalShards, checksum: s.checksum, code: made.code, len: made.len,
      })
    }
    this.#manifest = { ...(had2 ? this.#manifest : {
      agentId: this.#agentId, threshold: this.#threshold, totalShards: this.#totalShards, hiddenAt: Date.now(),
    }), formats: [...this.#writeFormats], ...(had2 ? { shardKeys3: keys3 } : { shardKeys: keys3 }), parity: made.code }
    return this.#manifest
  }

  /** Format-3 records of the unsigned path: verified by shape and checksum (damage), not by signature. */
  async #collectPlain3() {
    const keys = await this.#shardKeys(3)
    const groups = new Map()
    for (let i = 0; i < keys.length; i++) {
      const rec = this.#dhtNode.get(keys[i])
      if (rec === undefined || rec === null) continue
      const bytes = await this.#checkRecord3(rec, i)
      if (!bytes) continue
      const g = groups.get(`${rec.code}|${rec.len}`) ?? groups.set(`${rec.code}|${rec.len}`, { code: rec.code, len: rec.len, have: new Map() }).get(`${rec.code}|${rec.len}`)
      g.have.set(i, bytes)
    }
    let best = null
    for (const g of groups.values()) if (!best || g.have.size > best.have.size) best = g
    return best
  }

  /**
   * Shape and checksum check of one format-3 record: returns its bytes, or null after counting why not. A record that is
   * not shaped like format 3 is `shardMalformed`; one whose bytes do not match its checksum is `shardCorrupt`.
   */
  async #checkRecord3(rec, i) {
    const s = this.#stats
    if (typeof rec !== 'object' || rec.v !== 3 || rec.i !== i || typeof rec.data !== 'string' || !isChecksum3(rec.checksum)
      || !PARITY_CODES.includes(rec.code) || !Number.isSafeInteger(rec.len) || rec.len < 0
      // a resource bound: no state needs more data per shard than this, so a larger string is not decoded
      || rec.data.length > Math.ceil(shardBytes(MAX_STATE_BYTES, this.#threshold) * 4 / 3) + 4) { s.shardMalformed++; return null }
    let bytes
    try { bytes = strictFromB64u(rec.data) } catch { s.shardMalformed++; return null }
    if (bytes.length !== shardBytes(rec.len, this.#threshold)) { s.shardMalformed++; return null }
    const want = await stealthShardChecksum({ index: i, threshold: this.#threshold, total: this.#totalShards, code: rec.code, len: rec.len, bytes })
    if (want !== rec.checksum) { s.shardCorrupt++; return null }
    return bytes
  }

  async #reconstituteUnsignedAsync() {
    if (this.#readFormats.join() === '2') return this.#reconstituteUnsigned()
    if (this.#readFormats.includes(3)) {
      const g = await this.#collectPlain3()
      if (g && g.have.size >= this.#threshold) return this.#join3(g)
    }
    if (!this.#readFormats.includes(2)) throw new StealthError('unavailable', 'too few valid format-3 shards')
    return this.#reconstituteUnsigned()
  }

  #join3(g) {
    try { return joinState3(g.have, this.#threshold, this.#totalShards, g.code, g.len) } catch (e) { throw new StealthError('unavailable', e.message) }
  }

  // -- signed shards (and agent-anonymous DHT keys) ---------------------------

  /**
   * The DHT keys of this agent's shards: `stealth:<agentId>:shard:<i>` (format 3: `shard3`), or with a lookup nonce
   * `hex(SHA-256(agentId, nonce, i))` (format 3: the `lookup/3` label, so a different key).
   */
  async #shardKeys(format = 2) {
    const keys = []
    for (let i = 0; i < this.#totalShards; i++) {
      keys.push(this.#lookupNonce === null
        ? `stealth:${this.#agentId}:shard${format === 3 ? '3' : ''}:${i}`
        : await sha256Hex(`browsermesh-stealth/lookup/${format === 3 ? 3 : 1}\0${this.#agentId}\0${this.#lookupNonce}\0${i}`))
    }
    return keys
  }

  /** The exact text a shard signature covers: the agent, the key it lives under, its place and write, its content and the lookup nonce. */
  async #signedText({ key, i, seq, threshold, total, checksum, data }) {
    return `${SHARD_DOMAIN}\nagent:${this.#agentId}\nkey:${key}\nindex:${i}\nseq:${seq}\nthreshold:${threshold}\ntotal:${total}\nchecksum:${checksum}\nnonce:${this.#lookupNonce ?? ''}\ndata:${await sha256Hex(data)}`
  }

  /**
   * Format 3: the signature covers the agent, key, index, write and nonce, and the whole-digest checksum, which itself commits to
   * the shard's bytes, index, threshold, total, parity code and state length: so those are signed through it, and not repeated.
   */
  #signedText3({ key, i, seq, threshold, total, checksum }) {
    return `${SHARD_DOMAIN_3}\nagent:${this.#agentId}\nkey:${key}\nindex:${i}\nseq:${seq}\nthreshold:${threshold}\ntotal:${total}\nchecksum:${checksum}\nnonce:${this.#lookupNonce ?? ''}`
  }

  #requireIdentity() {
    if (!this.#identity) throw new StealthError('no-identity', 'signed shards need an identity (see the identity option)')
  }

  /**
   * Like `hide()`, but every shard is signed with the agent's identity, and with a `lookupNonce` stored
   * under keys that do not name the agent. Requires `identity`. The shards are still plaintext slices of
   * `stateBlob` (use `hideEncrypted()` to seal them as well).
   * @param {string} stateBlob
   * @returns {Promise<object>} Manifest (`signed: true`, `shardKeys`, `anonymous`, `seq`)
   */
  async hideSigned(stateBlob) {
    this.#requireIdentity()
    return this.#hideSignedNow(stateBlob)
  }

  async #hideSignedNow(stateBlob) {
    if (/[\r\n]/.test(this.#agentId)) throw new StealthError('bad-argument', 'agentId must not contain line breaks when shards are signed')
    const write2 = this.#writeFormats.includes(2)
    const write3 = this.#writeFormats.includes(3)
    const seq = Math.max(this.#shardSeq + 1, Date.now())
    const anonymous = this.#lookupNonce !== null
    const writes = [] // { key, record }, stored only once every signature exists
    let keys = null
    let shards = []
    if (write2) {
      shards = this.#distributor.split(this.#agentId, stateBlob)
      keys = await this.#shardKeys(2)
      for (let i = 0; i < shards.length; i++) {
        const j = shards[i].toJSON()
        const text = await this.#signedText({ key: keys[i], i, seq, threshold: j.threshold, total: j.total, checksum: j.checksum, data: j.data })
        const sig = toBase64Url(new Uint8Array(await this.#identity.sign(new TextEncoder().encode(text))))
        // An anonymous record names neither the agent nor the shard: only what the reader needs.
        writes.push({ key: keys[i], record: anonymous
          ? { v: 2, i, data: j.data, checksum: j.checksum, seq, sig }
          : { ...j, v: 2, i, seq, sig } })
      }
    }
    let keys3 = null
    if (write3) {
      const made = await this.#makeShards3(stateBlob)
      keys3 = await this.#shardKeys(3)
      for (const s of made.shards) {
        const text = this.#signedText3({ key: keys3[s.i], i: s.i, seq, threshold: this.#threshold, total: this.#totalShards, checksum: s.checksum })
        const sig = toBase64Url(new Uint8Array(await this.#identity.sign(new TextEncoder().encode(text))))
        writes.push({ key: keys3[s.i], record: anonymous
          ? { v: 3, i: s.i, data: s.data, checksum: s.checksum, code: made.code, len: made.len, seq, sig }
          : { v: 3, shardId: `${this.#agentId}:shard3:${s.i}`, agentId: this.#agentId, i: s.i, data: s.data, threshold: this.#threshold, total: this.#totalShards, checksum: s.checksum, code: made.code, len: made.len, seq, sig } })
      }
    }
    for (const { key, record } of writes) this.#dhtNode.store(key, record)
    this.#shardSeq = seq
    this.#manifest = {
      agentId: this.#agentId,
      threshold: this.#threshold,
      totalShards: this.#totalShards,
      ...(anonymous || !write2 ? {} : { shardIds: shards.map((s) => s.shardId) }),
      shardKeys: keys ?? keys3,
      ...(write2 && write3 ? { shardKeys3: keys3 } : {}),
      hiddenAt: Date.now(),
      signed: true,
      anonymous,
      seq,
      ...(write3 ? { formats: [...this.#writeFormats], parity: this.#parity } : {}),
    }
    return this.#manifest
  }

  async #verifyKey(raw) {
    const id = toBase64Url(raw)
    let key = this.#verifyKeys.get(id)
    if (!key) {
      key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify'])
      this.#verifyKeys.set(id, key)
    }
    return key
  }

  /**
   * Collect the stored shards of every format this agent reads, refuse (and count) every one that does not verify, and
   * return the newest complete set: `{ seq, format, count, ... }` or null. Across formats the highest `seq` wins, a tie
   * prefers format 3; shards of any other write are never mixed in.
   */
  async #collectSigned() {
    const candidates = []
    if (this.#readFormats.includes(2)) for (const [seq, shards] of await this.#signedGroups2()) candidates.push({ seq, format: 2, count: shards.length, shards })
    if (this.#readFormats.includes(3)) for (const g of await this.#signedGroups3()) candidates.push({ ...g, format: 3, count: g.have.size })
    candidates.sort((a, b) => b.seq - a.seq || b.format - a.format)
    for (const c of candidates) {
      if (c.count >= this.#threshold) {
        for (const other of candidates) if (other.seq !== c.seq) this.#stats.shardStale += other.count
        return c
      }
    }
    return null
  }

  /** Format 3: the signed records, as groups of one write (`seq`, parity code, state length). */
  async #signedGroups3() {
    const keys = await this.#shardKeys(3)
    const signers = [new Uint8Array(await this.#identity.rawPublicKey()), ...this.#trustedKeys]
    const groups = new Map()
    for (let i = 0; i < keys.length; i++) {
      const rec = this.#dhtNode.get(keys[i])
      if (rec === undefined || rec === null) continue
      if (typeof rec === 'object' && typeof rec.sig !== 'string' && rec.v === 3) {
        // Unsigned format 3 (not written by this module): only with allowUnsigned, and still checksum-verified.
        if (!this.#allowUnsigned) { this.#stats.shardUnsigned++; continue }
        const bytes = await this.#checkRecord3(rec, i)
        if (!bytes) continue
        this.#stats.shardUnsignedAccepted++
        const g = groups.get('0|' + rec.code + '|' + rec.len) ?? groups.set('0|' + rec.code + '|' + rec.len, { seq: 0, code: rec.code, len: rec.len, have: new Map() }).get('0|' + rec.code + '|' + rec.len)
        g.have.set(i, bytes)
        continue
      }
      if (typeof rec === 'object' && typeof rec.sig !== 'string') { this.#stats.shardUnsigned++; continue }
      if (typeof rec !== 'object' || !Number.isSafeInteger(rec.seq)) { this.#stats.shardMalformed++; continue }
      const bytes = await this.#checkRecord3(rec, i) // shape, then the checksum: damage is told apart from forgery
      if (!bytes) continue
      let sigBytes
      try { sigBytes = fromBase64Url(rec.sig) } catch { this.#stats.shardMalformed++; continue }
      const text = new TextEncoder().encode(this.#signedText3({ key: keys[i], i, seq: rec.seq, threshold: this.#threshold, total: this.#totalShards, checksum: rec.checksum }))
      let ok = false
      for (const raw of signers) {
        try { if (await crypto.subtle.verify('Ed25519', await this.#verifyKey(raw), sigBytes, text)) { ok = true; break } } catch { /* try the next */ }
      }
      if (!ok) { this.#stats.shardBadSignature++; continue }
      const id = `${rec.seq}|${rec.code}|${rec.len}`
      const g = groups.get(id) ?? groups.set(id, { seq: rec.seq, code: rec.code, len: rec.len, have: new Map() }).get(id)
      g.have.set(i, bytes)
    }
    return [...groups.values()]
  }

  /** Format 2 (unchanged rules): the signed records as `seq -> StateShard[]`. */
  async #signedGroups2() {
    const keys = await this.#shardKeys(2)
    const own = new Uint8Array(await this.#identity.rawPublicKey())
    const signers = [own, ...this.#trustedKeys]
    const bySeq = new Map() // seq -> StateShard[]
    for (let i = 0; i < keys.length; i++) {
      const rec = this.#dhtNode.get(keys[i])
      if (rec === undefined || rec === null) continue
      if (typeof rec !== 'object') { this.#stats.shardMalformed++; continue }
      if (typeof rec.sig !== 'string') {
        // Written by an older peer: no signature at all.
        if (!this.#allowUnsigned) { this.#stats.shardUnsigned++; continue }
        try {
          const shard = StateShard.fromJSON(rec)
          if (!shard.verify()) throw new Error('checksum')
          this.#stats.shardUnsignedAccepted++
          const list = bySeq.get(0) ?? bySeq.set(0, []).get(0)
          list.push(new StateShard({ shardId: `${this.#agentId}:shard:${i}`, agentId: this.#agentId, data: shard.data, threshold: shard.threshold, total: shard.total, checksum: shard.checksum }))
        } catch { this.#stats.shardMalformed++ }
        continue
      }
      const { data, checksum, seq } = rec
      if (rec.i !== i || typeof data !== 'string' || !Number.isSafeInteger(checksum) || !Number.isSafeInteger(seq)) { this.#stats.shardBadSignature++; continue }
      let sigBytes
      try { sigBytes = fromBase64Url(rec.sig) } catch { this.#stats.shardMalformed++; continue }
      // threshold and total are this agent's own configuration, not whatever the record says.
      const bytes = new TextEncoder().encode(await this.#signedText({ key: keys[i], i, seq, threshold: this.#threshold, total: this.#totalShards, checksum, data }))
      let ok = false
      for (const raw of signers) {
        try { if (await crypto.subtle.verify('Ed25519', await this.#verifyKey(raw), sigBytes, bytes)) { ok = true; break } } catch { /* try the next */ }
      }
      if (!ok) { this.#stats.shardBadSignature++; continue }
      const list = bySeq.get(seq) ?? bySeq.set(seq, []).get(seq)
      list.push(new StateShard({ shardId: `${this.#agentId}:shard:${i}`, agentId: this.#agentId, data, threshold: this.#threshold, total: this.#totalShards, checksum }))
    }
    return bySeq
  }

  async #reconstituteSignedNow() {
    const set = await this.#collectSigned()
    if (set === null) throw new StealthError('unavailable', `only 0 of the ${this.#threshold} shards needed are valid`)
    if (set.format === 3) return this.#join3(set)
    try { return this.#collector.reconstruct(set.shards) } catch (e) { throw new StealthError('unavailable', e.message) }
  }

  /**
   * Reconstitute state stored by `hideSigned()`: every shard's signature (and the key it was stored
   * under) is verified, shards that do not verify are refused and counted (`stats.shardBadSignature`,
   * `shardUnsigned`, `shardStale`), and the newest complete write is used. Rejects with
   * `StealthError` `unavailable` when too few valid shards remain.
   * @returns {Promise<string>}
   */
  async reconstituteSigned() {
    this.#requireIdentity()
    return this.#reconstituteSignedNow()
  }

  /** Like `reconstituteSigned()` but resolves `{ ok: true, state }` or `{ ok: false, reason }` instead of rejecting. */
  async tryReconstituteSigned() {
    this.#requireIdentity()
    try { return { ok: true, state: await this.#reconstituteSignedNow() } } catch (e) {
      if (e instanceof StealthError) { this.#stats.unavailable++; return { ok: false, reason: e.code } }
      throw e
    }
  }

  /** With an identity: whether enough valid, verified shards exist (the async form of `isViable()`). */
  async isRecoverable() {
    this.#requireIdentity()
    return (await this.#collectSigned()) !== null
  }

  /**
   * Reconstitute and decrypt state stored by `hideEncrypted()`. Rejects with
   * a `StealthError` (`code`: no-key, not-encrypted, unknown-key, tampered,
   * replayed, stale, malformed) when the state cannot be trusted. With a
   * keyring, state older than the newest this agent wrote or accepted is
   * refused as `replayed`. Use `tryReconstituteEncrypted()` where failures are
   * routine.
   * @returns {Promise<string>}
   */
  async reconstituteEncrypted() {
    if (!this.#key && !this.#keyring) throw new StealthError('no-key', 'reconstituteEncrypted requires a key or keyring (see deriveStealthKey / StealthKeyring)')
    return this.#open(await this.#load())
  }

  async #open(raw) {
    if (raw.startsWith(V2_PREFIX)) {
      if (!this.#keyring) throw new StealthError('no-key', 'state is sealed under a keyring; this agent has none')
      const r = await openStealthMessage(raw, {
        keyring: this.#keyring, sender: this.#agentId, type: 'state',
        minSeq: Math.max(this.#highestSeen, this.#seq), maxAgeMs: this.#maxAgeMs,
      })
      this.#highestSeen = Math.max(this.#highestSeen, r.seq)
      return r.plaintext
    }
    if (raw.startsWith(ENC_PREFIX)) {
      if (!this.#key) throw new StealthError('no-key', 'state is sealed under a single key; this agent has none')
      try { return await decryptStealthState(raw, this.#key, this.#agentId) } catch { throw new StealthError('tampered', 'authentication failed') }
    }
    throw new StealthError('not-encrypted', 'the stored state is not encrypted')
  }

  /**
   * Like `reconstituteEncrypted()` but never throws for an untrusted or
   * unreadable state: it resolves `{ ok: true, state }` or
   * `{ ok: false, reason }` and counts the outcome in `stats`. A peer without
   * the key, or looking at plaintext or foreign state, gets a quiet `false`.
   * Reasons: unavailable (too few shards), no-key, not-encrypted, unknown-key,
   * tampered, replayed, stale, malformed.
   * @returns {Promise<{ ok: true, state: string } | { ok: false, reason: string }>}
   */
  async tryReconstituteEncrypted() {
    let raw
    try { raw = await this.#load() } catch { this.#stats.unavailable++; return { ok: false, reason: 'unavailable' } }
    try {
      const state = await this.#open(raw)
      this.#stats.opened++
      return { ok: true, state }
    } catch (err) {
      const code = err instanceof StealthError ? err.code : 'malformed'
      const slot = { 'no-key': 'noKey', 'not-encrypted': 'notEncrypted', 'unknown-key': 'unknownKey' }[code] ?? code
      this.#stats[slot in this.#stats ? slot : 'malformed']++
      return { ok: false, reason: slot in this.#stats ? code : 'malformed' }
    }
  }

  /** Counters for `tryReconstituteEncrypted()` outcomes (the throwing variant does not count). @returns {object} */
  get stats() { return { ...this.#stats } }

  /**
   * Reconstitute the agent's state from DHT shards.
   * @returns {string} Reconstructed state blob
   */
  reconstitute() {
    this.#requireUnsignedAgent()
    return this.#reconstituteUnsigned()
  }

  #reconstituteUnsigned() {
    const shards = this.#collector.collect(this.#agentId, this.#totalShards)
    return this.#collector.reconstruct(shards)
  }

  /**
   * Check if enough shards are available for reconstitution.
   * @returns {boolean}
   */
  isViable() {
    this.#requireUnsignedAgent()
    const count = this.#collector.probe(this.#agentId, this.#totalShards)
    return count >= this.#threshold
  }

  /**
   * Get the stored shard manifest.
   * @returns {object|null}
   */
  getManifest() {
    return this.#manifest
  }
}
