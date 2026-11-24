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
 *     tampering;
 *   - keys name the agent they belong to.
 *
 * For secrecy use the opt-in encrypted path: derive a per-group AES-256-GCM key
 * with `deriveStealthKey(groupSecret, groupId)` and call
 * `StealthAgent#hideEncrypted()` / `#reconstituteEncrypted()` (async). The
 * state is sealed before sharding, bound to the agent id, so shard holders see
 * only ciphertext. That is the first half of #230; threshold sharing of the
 * key, signed shards and agent-anonymous DHT keys are NOT done (see the issue).
 * The plain synchronous `hide()` / `reconstitute()` are unchanged and plaintext.
 *
 * With a `StealthKeyring` (`keyring` option) the sealed state uses the v2
 * envelope: key id (so keys rotate), sequence number and issue time (so an
 * older state is refused as replayed), all authenticated with the sender and
 * type as AES-GCM associated data. Peers without the key get a quiet,
 * counted failure from `tryReconstituteEncrypted()`.
 *
 * What it hides, and from whom: the CONTENT of the state from whoever holds
 * the DHT shards (shard-holding nodes and relays). It does NOT hide that an
 * agent exists (keys are `stealth:<agentId>:shard:<i>`), how large its state
 * is, when it is written or read, or who reads it (traffic analysis). Every
 * holder of the group key can read and forge state: the sender in the
 * associated data is a label, not a signature. Threshold sharing of the key is
 * a design only (docs/design/stealth-threshold.md), not built.
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
  }

  /**
   * @param {object} opts
   * @param {string} opts.agentId - Agent identifier
   * @param {import('./dht.mjs').DhtNode} opts.dhtNode - DHT node
   * @param {number} [opts.threshold=3] - Minimum shards for recovery
   * @param {number} [opts.totalShards=5] - Total shards to create
   * @param {CryptoKey} [opts.key] - AES-GCM key (see `deriveStealthKey`); enables `hideEncrypted()` / `reconstituteEncrypted()`
   */
  constructor({ agentId, dhtNode, threshold = 3, totalShards = 5, key = null, keyring = null, maxAgeMs }) {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId is required and must be a non-empty string')
    }
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
      this.hide(sealed)
      this.#manifest = { ...this.#manifest, encrypted: true, keyId: sealed.split('.')[1], seq }
      return this.#manifest
    }
    if (!this.#key) throw new StealthError('no-key', 'hideEncrypted requires a key or keyring (see deriveStealthKey / StealthKeyring)')
    const sealed = await encryptStealthState(stateBlob, this.#key, this.#agentId)
    this.hide(sealed)
    this.#manifest = { ...this.#manifest, encrypted: true }
    return this.#manifest
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
    return this.#open(this.reconstitute())
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
    try { raw = this.reconstitute() } catch { this.#stats.unavailable++; return { ok: false, reason: 'unavailable' } }
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
    const shards = this.#collector.collect(this.#agentId, this.#totalShards)
    return this.#collector.reconstruct(shards)
  }

  /**
   * Check if enough shards are available for reconstitution.
   * @returns {boolean}
   */
  isViable() {
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
