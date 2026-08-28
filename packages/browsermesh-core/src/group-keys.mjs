/**
 * clawser-mesh-group-keys.js -- Symmetric group encryption for multi-party sessions.
 *
 * Epoch-based key rotation with AES-GCM-256. Forward secrecy on member removal
 * by generating a new epoch key and distributing it only to remaining members.
 *
 * Wire handlers: 0x80-0x83 (GROUP_KEY_DISTRIBUTE, GROUP_KEY_ROTATE,
 * GROUP_KEY_REQUEST, GROUP_KEY_ACK).
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-group-keys.test.mjs
 */

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

export const GROUP_KEY_DISTRIBUTE = 0x80
export const GROUP_KEY_ROTATE = 0x81
export const GROUP_KEY_REQUEST = 0x82
export const GROUP_KEY_ACK = 0x83

// ---------------------------------------------------------------------------
// Per-member envelope encryption (X25519 ECDH + AES-GCM key wrap)
// ---------------------------------------------------------------------------

/**
 * Whether this environment's WebCrypto supports X25519 ECDH, required for
 * per-member envelope encryption. Older browsers only support P-256/P-384
 * ECDH — group key distribution falls back to metadata-only (current
 * behavior) when this is false.
 * @returns {boolean}
 */
export function supportsX25519() {
  return typeof crypto !== 'undefined' && !!crypto.subtle
}

function bytesToB64(bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function b64ToBytes(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * Generate a fresh X25519 keypair for group-key envelope encryption.
 * This is a SEPARATE keypair from a pod's Ed25519 signing identity — X25519
 * is for key agreement (ECDH), Ed25519 for signatures; they're different
 * curves with different WebCrypto algorithm identifiers.
 *
 * @returns {Promise<CryptoKeyPair>}
 */
export async function generateEncryptionKeyPair() {
  return crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveKey', 'deriveBits'])
}

/**
 * Wrap an AES-GCM epoch key for one recipient using ECDH + AES-GCM key
 * wrap. Uses a fresh ephemeral X25519 keypair per envelope (ECIES-style) —
 * the sender's long-term private key is never used directly, so a single
 * envelope's compromise doesn't expose other envelopes.
 *
 * @param {CryptoKey} epochKey - The AES-GCM key to protect (must be extractable)
 * @param {CryptoKey} recipientPublicKey - Recipient's X25519 public key
 * @returns {Promise<{ephemeralPublicKey: string, wrappedKey: string, iv: string}>} base64-encoded
 */
export async function wrapKeyForMember(epochKey, recipientPublicKey) {
  const ephemeral = await generateEncryptionKeyPair()
  const sharedKek = await crypto.subtle.deriveKey(
    { name: 'X25519', public: recipientPublicKey },
    ephemeral.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await crypto.subtle.wrapKey('raw', epochKey, sharedKek, { name: 'AES-GCM', iv })
  const ephemeralPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
  return {
    ephemeralPublicKey: bytesToB64(ephemeralPublicRaw),
    wrappedKey: bytesToB64(new Uint8Array(wrapped)),
    iv: bytesToB64(iv),
  }
}

/**
 * Unwrap an epoch key envelope using this member's X25519 private key.
 *
 * @param {{ephemeralPublicKey: string, wrappedKey: string, iv: string}} envelope - base64-encoded
 * @param {CryptoKey} recipientPrivateKey - This member's X25519 private key
 * @returns {Promise<CryptoKey>} The unwrapped AES-GCM epoch key
 */
export async function unwrapKeyForMember(envelope, recipientPrivateKey) {
  const ephemeralPublicRaw = b64ToBytes(envelope.ephemeralPublicKey)
  const ephemeralPublicKey = await crypto.subtle.importKey('raw', ephemeralPublicRaw, { name: 'X25519' }, true, [])
  const sharedKek = await crypto.subtle.deriveKey(
    { name: 'X25519', public: ephemeralPublicKey },
    recipientPrivateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['unwrapKey'],
  )
  const wrapped = b64ToBytes(envelope.wrappedKey)
  const iv = b64ToBytes(envelope.iv)
  return crypto.subtle.unwrapKey(
    'raw', wrapped, sharedKek, { name: 'AES-GCM', iv },
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  )
}

// ---------------------------------------------------------------------------
// GroupState — tracks a single epoch
// ---------------------------------------------------------------------------

/**
 * Represents a single epoch's group key state.
 */
export class GroupState {
  /** @type {number} */
  #epoch

  /** @type {CryptoKey|null} */
  #key

  /** @type {Set<string>} */
  #members

  /** @type {number} */
  #createdAt

  /**
   * @param {object} opts
   * @param {number} opts.epoch
   * @param {CryptoKey|null} opts.key
   * @param {string[]} opts.members
   * @param {number} [opts.createdAt]
   */
  constructor({ epoch, key, members, createdAt = Date.now() }) {
    if (typeof epoch !== 'number' || epoch < 0) {
      throw new Error('epoch must be a non-negative number')
    }
    this.#epoch = epoch
    this.#key = key
    this.#members = new Set(members)
    this.#createdAt = createdAt
  }

  get epoch() { return this.#epoch }
  get key() { return this.#key }
  get members() { return [...this.#members] }
  get memberCount() { return this.#members.size }
  get createdAt() { return this.#createdAt }

  hasMember(podId) { return this.#members.has(podId) }

  toJSON() {
    return {
      epoch: this.#epoch,
      members: [...this.#members],
      createdAt: this.#createdAt,
    }
  }
}

// ---------------------------------------------------------------------------
// GroupKeyManager
// ---------------------------------------------------------------------------

/**
 * Manages symmetric group keys with epoch-based rotation.
 * Each epoch has a unique AES-GCM-256 key shared by all group members.
 * On member removal, a new epoch is created for forward secrecy.
 */
export class GroupKeyManager {
  /** @type {string} */
  #localPodId

  /** @type {string} */
  #groupId

  /** @type {Map<number, GroupState>} epoch -> GroupState */
  #epochs = new Map()

  /** @type {number} */
  #currentEpoch = -1

  /** @type {number} */
  #maxEpochHistory

  /** @type {function|null} */
  #broadcastFn = null

  /** @type {CryptoKeyPair|null} This pod's X25519 keypair for envelope encryption */
  #encryptionKeyPair = null

  /** @type {Map<string, CryptoKey>} podId -> X25519 public key */
  #memberPublicKeys = new Map()

  /** @type {boolean} Warn once when falling back to metadata-only distribution */
  #warnedNoEnvelope = false

  /** @type {function|null} */
  #onLog

  /**
   * @param {object} opts
   * @param {string} opts.localPodId
   * @param {string} opts.groupId
   * @param {number} [opts.maxEpochHistory=10]
   * @param {function} [opts.onLog]
   */
  constructor({ localPodId, groupId, maxEpochHistory = 10, onLog } = {}) {
    if (!localPodId) throw new Error('localPodId is required')
    if (!groupId) throw new Error('groupId is required')
    this.#localPodId = localPodId
    this.#groupId = groupId
    this.#maxEpochHistory = maxEpochHistory
    this.#onLog = onLog || null
  }

  get localPodId() { return this.#localPodId }
  get groupId() { return this.#groupId }
  get currentEpoch() { return this.#currentEpoch }
  get epochCount() { return this.#epochs.size }

  /**
   * Generate (or regenerate) this pod's X25519 keypair used to receive
   * per-member group-key envelopes. Must be called before this pod can
   * be sent an encrypted envelope by other members — advertise the
   * returned public key via peer discovery/registry metadata.
   *
   * @returns {Promise<string|null>} base64 raw public key, or null when
   *   X25519 is unsupported in this environment.
   */
  async initEncryption() {
    if (!supportsX25519()) {
      this.#encryptionKeyPair = null
      return null
    }
    this.#encryptionKeyPair = await generateEncryptionKeyPair()
    return this.getPublicKeyRaw()
  }

  /**
   * This pod's own X25519 public key, base64-encoded, for advertising to
   * other members so they can encrypt envelopes addressed to this pod.
   * @returns {Promise<string|null>}
   */
  async getPublicKeyRaw() {
    if (!this.#encryptionKeyPair) return null
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', this.#encryptionKeyPair.publicKey))
    return bytesToB64(raw)
  }

  /**
   * Register another member's X25519 public key so envelopes can be
   * addressed to them in `broadcastDistribute`.
   *
   * @param {string} podId
   * @param {string|Uint8Array} publicKeyRaw - base64 string or raw bytes
   */
  async setMemberPublicKey(podId, publicKeyRaw) {
    const raw = typeof publicKeyRaw === 'string' ? b64ToBytes(publicKeyRaw) : publicKeyRaw
    const key = await crypto.subtle.importKey('raw', raw, { name: 'X25519' }, true, [])
    this.#memberPublicKeys.set(podId, key)
  }

  /** @param {string} podId @returns {boolean} */
  hasMemberPublicKey(podId) {
    return this.#memberPublicKeys.has(podId)
  }

  #log(msg) {
    if (this.#onLog) this.#onLog(msg)
    else if (typeof console !== 'undefined') console.warn(`[GroupKeyManager] ${msg}`)
  }

  /**
   * Get the current group state.
   * @returns {GroupState|null}
   */
  getCurrentState() {
    return this.#epochs.get(this.#currentEpoch) || null
  }

  /**
   * Get a specific epoch's state.
   * @param {number} epoch
   * @returns {GroupState|null}
   */
  getEpochState(epoch) {
    return this.#epochs.get(epoch) || null
  }

  /**
   * Initialize a new group with the given members.
   * Generates the first epoch key (epoch 0).
   *
   * @param {string[]} members - Pod IDs of initial members
   * @returns {Promise<GroupState>}
   */
  async initGroup(members) {
    if (!Array.isArray(members) || members.length === 0) {
      throw new Error('members must be a non-empty array')
    }
    // Ensure localPodId is included
    const allMembers = new Set(members)
    allMembers.add(this.#localPodId)

    const key = await this.#generateKey()
    const epoch = 0
    const state = new GroupState({
      epoch,
      key,
      members: [...allMembers],
    })

    this.#epochs.set(epoch, state)
    this.#currentEpoch = epoch
    return state
  }

  /**
   * Rotate the group key to a new epoch.
   * Used when adding a member (existing key is fine, but new epoch
   * ensures clean key lifecycle) or periodically for key freshness.
   *
   * @param {string[]} [newMembers] - Updated member list; defaults to current members
   * @returns {Promise<GroupState>}
   */
  async rotate(newMembers) {
    const current = this.getCurrentState()
    const members = newMembers || (current ? current.members : [this.#localPodId])

    const nextEpoch = this.#currentEpoch + 1
    const key = await this.#generateKey()
    const state = new GroupState({
      epoch: nextEpoch,
      key,
      members,
    })

    this.#epochs.set(nextEpoch, state)
    this.#currentEpoch = nextEpoch
    this.#pruneOldEpochs()
    return state
  }

  /**
   * Remove a member and rotate the key for forward secrecy.
   * The removed member will not receive the new epoch key.
   *
   * @param {string} podId - Pod ID to remove
   * @returns {Promise<GroupState>}
   */
  async removeMember(podId) {
    const current = this.getCurrentState()
    if (!current) throw new Error('No active group state')
    if (!current.hasMember(podId)) throw new Error(`${podId} is not a member`)

    const remaining = current.members.filter(m => m !== podId)
    if (remaining.length === 0) throw new Error('Cannot remove the last member')

    return this.rotate(remaining)
  }

  /**
   * Add a member and rotate the key.
   *
   * @param {string} podId - Pod ID to add
   * @returns {Promise<GroupState>}
   */
  async addMember(podId) {
    const current = this.getCurrentState()
    if (!current) throw new Error('No active group state')
    if (current.hasMember(podId)) throw new Error(`${podId} is already a member`)

    const updated = [...current.members, podId]
    return this.rotate(updated)
  }

  /**
   * Encrypt data with the current epoch key.
   *
   * @param {Uint8Array} plaintext
   * @returns {Promise<{ ciphertext: Uint8Array, iv: Uint8Array, epoch: number }>}
   */
  async encrypt(plaintext) {
    const state = this.getCurrentState()
    if (!state || !state.key) throw new Error('No active group key')

    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        state.key,
        plaintext,
      ),
    )

    return { ciphertext, iv, epoch: state.epoch }
  }

  /**
   * Decrypt data using the specified epoch key.
   *
   * @param {Uint8Array} ciphertext
   * @param {Uint8Array} iv
   * @param {number} epoch
   * @returns {Promise<Uint8Array>}
   */
  async decrypt(ciphertext, iv, epoch) {
    const state = this.#epochs.get(epoch)
    if (!state || !state.key) throw new Error(`No key for epoch ${epoch}`)

    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        state.key,
        ciphertext,
      ),
    )

    return plaintext
  }

  /**
   * Accept an epoch key distributed by another member.
   *
   * @param {number} epoch
   * @param {CryptoKey} key
   * @param {string[]} members
   */
  acceptEpoch(epoch, key, members) {
    if (this.#epochs.has(epoch)) return // already have it

    const state = new GroupState({ epoch, key, members })
    this.#epochs.set(epoch, state)
    if (epoch > this.#currentEpoch) {
      this.#currentEpoch = epoch
    }
    this.#pruneOldEpochs()
  }

  /**
   * Wire the GroupKeyManager to a mesh transport layer.
   *
   * @param {function} broadcastFn - `(wireType: number, payload: object) => void`
   * @param {function} subscribeFn - `(wireType: number, handler: (payload, fromPodId) => void) => void`
   */
  wireTransport(broadcastFn, subscribeFn) {
    if (typeof broadcastFn !== 'function' || typeof subscribeFn !== 'function') {
      throw new Error('broadcastFn and subscribeFn must be functions')
    }

    this.#broadcastFn = broadcastFn

    // Inbound: key distribution from group owner/rotator
    subscribeFn(GROUP_KEY_DISTRIBUTE, (payload, fromPodId) => {
      const { epoch, members, groupId, envelopes } = payload
      if (groupId !== this.#groupId) return
      if (!members?.includes(this.#localPodId)) return

      const envelope = envelopes?.[this.#localPodId]
      if (!envelope) {
        // Metadata-only broadcast (sender had no known public key for us,
        // or X25519 unsupported somewhere in the group) — no key material
        // to accept. The member must fall back to broadcastRequest() once
        // its own public key has been advertised/registered.
        return
      }
      if (!this.#encryptionKeyPair) {
        this.#log(`received envelope for epoch ${epoch} but local encryption key is not initialized (call initEncryption() first)`)
        return
      }

      unwrapKeyForMember(envelope, this.#encryptionKeyPair.privateKey)
        .then(key => this.acceptEpoch(epoch, key, members))
        .catch(err => this.#log(`failed to unwrap epoch ${epoch} envelope: ${err.message}`))
    })

    // Inbound: key rotation notification
    subscribeFn(GROUP_KEY_ROTATE, (payload, fromPodId) => {
      const { epoch, members, groupId } = payload
      if (groupId !== this.#groupId) return
      // Rotation accepted — key delivered via GROUP_KEY_DISTRIBUTE
    })

    // Inbound: key request (member asking for the current key)
    subscribeFn(GROUP_KEY_REQUEST, (payload, fromPodId) => {
      const { groupId } = payload
      if (groupId !== this.#groupId) return
      const current = this.getCurrentState()
      if (current && current.hasMember(fromPodId)) {
        // Respond with key distribution
        this.broadcastDistribute().catch(err => this.#log(`broadcastDistribute failed: ${err.message}`))
      }
    })

    // Inbound: acknowledgment of key receipt
    subscribeFn(GROUP_KEY_ACK, (payload, fromPodId) => {
      // Track which members have acknowledged the key
    })
  }

  /**
   * Broadcast the current epoch key to all members. When this pod's
   * encryption keypair is initialized and at least one other member's
   * public key is known, wraps the epoch key per-member (X25519 ECDH +
   * AES-GCM). Members with no known public key (or when X25519 is
   * unsupported) simply receive metadata and must catch up via
   * broadcastRequest() once their key is registered — a logged warning
   * marks this fallback so it's visible, not silent.
   */
  async broadcastDistribute() {
    if (!this.#broadcastFn) return
    const state = this.getCurrentState()
    if (!state) return

    const canEnvelope = supportsX25519() && !!this.#encryptionKeyPair
    let envelopes
    if (canEnvelope) {
      const targets = state.members.filter(m => m !== this.#localPodId && this.#memberPublicKeys.has(m))
      if (targets.length > 0) {
        envelopes = {}
        for (const podId of targets) {
          envelopes[podId] = await wrapKeyForMember(state.key, this.#memberPublicKeys.get(podId))
        }
      }
    }

    if (!envelopes && !this.#warnedNoEnvelope) {
      this.#warnedNoEnvelope = true
      this.#log(canEnvelope
        ? 'no member public keys registered — distributing epoch metadata only (members must request the key once registered)'
        : 'X25519 unsupported or local encryption key not initialized — distributing epoch metadata only')
    }

    this.#broadcastFn(GROUP_KEY_DISTRIBUTE, {
      groupId: this.#groupId,
      epoch: state.epoch,
      members: state.members,
      ...(envelopes ? { envelopes } : {}),
    })
  }

  /**
   * Broadcast a rotation notification.
   */
  broadcastRotation() {
    if (!this.#broadcastFn) return
    const state = this.getCurrentState()
    if (!state) return

    this.#broadcastFn(GROUP_KEY_ROTATE, {
      groupId: this.#groupId,
      epoch: state.epoch,
      members: state.members,
    })
  }

  /**
   * Broadcast a key request.
   */
  broadcastRequest() {
    if (!this.#broadcastFn) return
    this.#broadcastFn(GROUP_KEY_REQUEST, { groupId: this.#groupId })
  }

  /**
   * Broadcast a key acknowledgment.
   *
   * @param {number} epoch
   */
  broadcastAck(epoch) {
    if (!this.#broadcastFn) return
    this.#broadcastFn(GROUP_KEY_ACK, {
      groupId: this.#groupId,
      epoch,
      podId: this.#localPodId,
    })
  }

  // -- Internal helpers -----------------------------------------------------

  async #generateKey() {
    return crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
  }

  #pruneOldEpochs() {
    if (this.#epochs.size <= this.#maxEpochHistory) return
    const sorted = [...this.#epochs.keys()].sort((a, b) => a - b)
    const toRemove = sorted.slice(0, sorted.length - this.#maxEpochHistory)
    for (const epoch of toRemove) {
      this.#epochs.delete(epoch)
    }
  }
}
