/**
 * clawser-mesh-dht.js -- DHT/Gossip protocol for BrowserMesh.
 *
 * Provides Kademlia-style distributed hash table with XOR-based routing,
 * epidemic gossip protocol for state dissemination, and a DHT-backed
 * discovery strategy.
 *
 * KBucket is a fixed-size (k=20) peer bucket with LRU eviction.
 * RoutingTable provides 160-bit XOR-based routing with multiple buckets.
 * DhtNode implements Kademlia operations (ping, findNode, findValue, store).
 * GossipProtocol provides epidemic state dissemination with push/pull/digest.
 * DhtDiscoveryStrategy extends DiscoveryStrategy for DHT-based peer discovery.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-dht.test.mjs
 */

import { DiscoveryStrategy } from './discovery.mjs'

// ---------------------------------------------------------------------------
// Wire Constants
// ---------------------------------------------------------------------------

/** DHT ping message type. */
export const DHT_PING = 0xE8

/** DHT find node message type. */
export const DHT_FIND_NODE = 0xE9

/** DHT find value message type. */
export const DHT_FIND_VALUE = 0xEA

/** DHT store message type. */
export const DHT_STORE = 0xEB

/** Gossip push message type. */
export const GOSSIP_PUSH = 0xEC

/** Gossip pull message type. */
export const GOSSIP_PULL = 0xED

/** Gossip digest message type. */
export const GOSSIP_DIGEST = 0xEE

/** Stealth shard message type. */
export const STEALTH_SHARD = 0xEF

// ---------------------------------------------------------------------------
// XOR Distance Helpers
// ---------------------------------------------------------------------------

/**
 * Compute XOR distance between two string IDs.
 * Returns an array of XOR'd char codes.
 * @param {string} a
 * @param {string} b
 * @returns {number[]}
 */
function xorDistance(a, b) {
  const len = Math.max(a.length, b.length)
  const result = []
  for (let i = 0; i < len; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0
    const cb = i < b.length ? b.charCodeAt(i) : 0
    result.push(ca ^ cb)
  }
  return result
}

/**
 * Compare two XOR distance arrays. Returns negative if a < b, positive if a > b, 0 if equal.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function compareDistance(a, b) {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const va = i < a.length ? a[i] : 0
    const vb = i < b.length ? b[i] : 0
    if (va !== vb) return va - vb
  }
  return 0
}

/**
 * Find the index of the highest differing bit between two string IDs.
 * Returns 0 if the IDs are identical.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function highestBitIndex(a, b) {
  const dist = xorDistance(a, b)
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] !== 0) {
      // Find highest set bit in this byte
      let byte = dist[i]
      let bit = 7
      while (bit >= 0 && !(byte & (1 << bit))) {
        bit--
      }
      return i * 8 + (7 - bit)
    }
  }
  return 0
}

// ---------------------------------------------------------------------------
// KBucket
// ---------------------------------------------------------------------------

/**
 * Fixed-size peer bucket for Kademlia routing table.
 * Contacts are stored in an array, most-recently-seen at the end.
 */
export class KBucket {
  /** @type {number} */
  #k

  /** @type {Array<{podId: string, address?: string, lastSeen?: number}>} */
  #contacts = []

  /**
   * @param {number} [k=20] - Maximum bucket size
   */
  constructor(k = 20) {
    this.#k = k
  }

  /**
   * Add a contact to the bucket.
   * If the contact already exists, move it to the end (most recent).
   * If full, evict the LRU (oldest, index 0) contact.
   *
   * @param {{podId: string, address?: string, lastSeen?: number}} contact
   * @returns {{podId: string, address?: string, lastSeen?: number}|null} Evicted contact or null
   */
  add(contact) {
    // If already present, move to end
    const idx = this.#contacts.findIndex(c => c.podId === contact.podId)
    if (idx !== -1) {
      this.#contacts.splice(idx, 1)
      this.#contacts.push(contact)
      return null
    }

    // If full, evict LRU (oldest = index 0)
    let evicted = null
    if (this.#contacts.length >= this.#k) {
      evicted = this.#contacts.shift()
    }

    this.#contacts.push(contact)
    return evicted
  }

  /**
   * Remove a contact by podId.
   * @param {string} podId
   * @returns {boolean} true if found and removed
   */
  remove(podId) {
    const idx = this.#contacts.findIndex(c => c.podId === podId)
    if (idx === -1) return false
    this.#contacts.splice(idx, 1)
    return true
  }

  /**
   * Find a contact by podId.
   * @param {string} podId
   * @returns {{podId: string, address?: string, lastSeen?: number}|null}
   */
  get(podId) {
    return this.#contacts.find(c => c.podId === podId) ?? null
  }

  /**
   * Return up to `count` contacts sorted by XOR distance to targetId.
   * @param {string} targetId
   * @param {number} count
   * @returns {Array<{podId: string, address?: string, lastSeen?: number}>}
   */
  closest(targetId, count) {
    const sorted = [...this.#contacts].sort((a, b) => {
      const da = xorDistance(a.podId, targetId)
      const db = xorDistance(b.podId, targetId)
      return compareDistance(da, db)
    })
    return sorted.slice(0, count)
  }

  /** @returns {boolean} Whether the bucket is full */
  get isFull() {
    return this.#contacts.length >= this.#k
  }

  /** @returns {number} Number of contacts */
  get size() {
    return this.#contacts.length
  }

  /** @returns {Array<{podId: string, address?: string, lastSeen?: number}>} Copy of contacts array */
  get contacts() {
    return [...this.#contacts]
  }
}

// ---------------------------------------------------------------------------
// RoutingTable
// ---------------------------------------------------------------------------

/**
 * 160-bit XOR-based routing table composed of KBuckets.
 */
export class RoutingTable {
  /** @type {string} */
  #localId

  /** @type {number} */
  #k

  /** @type {KBucket[]} */
  #buckets

  /**
   * @param {string} localId - This node's identifier
   * @param {number} [k=20] - Bucket size
   * @param {number} [bucketCount=160] - Number of buckets
   */
  constructor(localId, k = 20, bucketCount = 160) {
    if (!localId || typeof localId !== 'string') {
      throw new Error('localId is required and must be a non-empty string')
    }
    this.#localId = localId
    this.#k = k
    this.#buckets = []
    for (let i = 0; i < bucketCount; i++) {
      this.#buckets.push(new KBucket(k))
    }
  }

  /**
   * Compute the bucket index for a given targetId.
   * Uses XOR distance and finds the highest differing bit.
   * If targetId equals localId, returns 0.
   *
   * @param {string} targetId
   * @returns {number}
   */
  getBucketIndex(targetId) {
    if (targetId === this.#localId) return 0
    const idx = highestBitIndex(this.#localId, targetId)
    return Math.min(idx, this.#buckets.length - 1)
  }

  /**
   * Add a contact to the appropriate bucket.
   * @param {{podId: string, address?: string, lastSeen?: number}} contact
   * @returns {{podId: string, address?: string, lastSeen?: number}|null} Evicted contact or null
   */
  addContact(contact) {
    const idx = this.getBucketIndex(contact.podId)
    return this.#buckets[idx].add(contact)
  }

  /**
   * Remove a contact by podId from the appropriate bucket.
   * @param {string} podId
   * @returns {boolean}
   */
  removeContact(podId) {
    const idx = this.getBucketIndex(podId)
    return this.#buckets[idx].remove(podId)
  }

  /**
   * Find the closest contacts to a target across all buckets.
   * @param {string} targetId
   * @param {number} [count=20]
   * @returns {Array<{podId: string, address?: string, lastSeen?: number}>}
   */
  findClosest(targetId, count = 20) {
    const all = []
    for (const bucket of this.#buckets) {
      all.push(...bucket.contacts)
    }
    all.sort((a, b) => {
      const da = xorDistance(a.podId, targetId)
      const db = xorDistance(b.podId, targetId)
      return compareDistance(da, db)
    })
    return all.slice(0, count)
  }

  /**
   * Return list of bucket indices that have no contacts (stale/empty).
   * @returns {number[]}
   */
  refresh() {
    const stale = []
    for (let i = 0; i < this.#buckets.length; i++) {
      if (this.#buckets[i].size === 0) {
        stale.push(i)
      }
    }
    return stale
  }

  /**
   * Total contacts across all buckets.
   * @returns {number}
   */
  get size() {
    let total = 0
    for (const bucket of this.#buckets) {
      total += bucket.size
    }
    return total
  }
}

// ---------------------------------------------------------------------------
// DhtNode
// ---------------------------------------------------------------------------

/**
 * Kademlia DHT node implementing core operations.
 */
export class DhtNode {
  /** @type {string} */
  #localId

  /** @type {RoutingTable} */
  #routingTable

  /** @type {Map<string, {value: *, ttl: number, storedAt: number}>} */
  #store

  /** @type {Function} */
  #sendFn

  /**
   * @param {object} opts
   * @param {string} opts.localId - This node's identifier
   * @param {RoutingTable} [opts.routingTable] - Routing table instance
   * @param {Map} [opts.store] - Local key-value store
   * @param {Function} [opts.sendFn] - Function to send messages: (targetId, msg) => {}
   */
  constructor({ localId, routingTable, store, sendFn }) {
    if (!localId || typeof localId !== 'string') {
      throw new Error('localId is required and must be a non-empty string')
    }
    this.#localId = localId
    this.#routingTable = routingTable ?? new RoutingTable(localId)
    this.#store = store ?? new Map()
    this.#sendFn = sendFn ?? (() => {})
  }

  /** @returns {string} */
  get localId() {
    return this.#localId
  }

  /** @returns {RoutingTable} */
  get routingTable() {
    return this.#routingTable
  }

  /**
   * Ping a target node. Simulates liveness check.
   * @param {string} targetId
   * @returns {boolean}
   */
  ping(targetId) {
    this.#sendFn(targetId, { type: DHT_PING, from: this.#localId })
    return true
  }

  /**
   * Find the closest nodes to a given targetId.
   * @param {string} targetId
   * @returns {Array<{podId: string, address?: string, lastSeen?: number}>}
   */
  findNode(targetId) {
    return this.#routingTable.findClosest(targetId)
  }

  /**
   * Find a value by key. Checks local store first, then returns closest nodes.
   * @param {string} key
   * @returns {{found: boolean, value?: *, closest?: Array}}
   */
  findValue(key) {
    const entry = this.#store.get(key)
    if (entry) {
      // Check TTL
      if (entry.ttl > 0 && Date.now() > entry.storedAt + entry.ttl) {
        this.#store.delete(key)
      } else {
        return { found: true, value: entry.value }
      }
    }
    return { found: false, closest: this.findNode(key) }
  }

  /**
   * Store a key-value pair locally and replicate to closest nodes.
   * @param {string} key
   * @param {*} value
   * @param {number} [ttl=0] - Time-to-live in ms (0 = no expiry)
   */
  store(key, value, ttl = 0) {
    this.#store.set(key, { value, ttl, storedAt: Date.now() })

    // Replicate to closest nodes
    const closest = this.#routingTable.findClosest(key)
    for (const contact of closest) {
      this.#sendFn(contact.podId, {
        type: DHT_STORE,
        from: this.#localId,
        key,
        value,
        ttl,
      })
    }
  }

  /**
   * Handle an incoming DHT message. Always adds sender to routing table.
   * @param {string} fromId - Sender's ID
   * @param {object} msg - Message object with `type` field
   * @returns {*} Response depending on message type
   */
  handleMessage(fromId, msg) {
    // Always add sender to routing table
    this.#routingTable.addContact({ podId: fromId, lastSeen: Date.now() })

    switch (msg.type) {
      case DHT_PING:
        return { type: DHT_PING, from: this.#localId, pong: true }

      case DHT_FIND_NODE:
        return {
          type: DHT_FIND_NODE,
          from: this.#localId,
          closest: this.findNode(msg.targetId ?? fromId),
        }

      case DHT_FIND_VALUE:
        return {
          type: DHT_FIND_VALUE,
          from: this.#localId,
          ...this.findValue(msg.key),
        }

      case DHT_STORE:
        if (msg.key !== undefined && msg.value !== undefined) {
          this.#store.set(msg.key, {
            value: msg.value,
            ttl: msg.ttl ?? 0,
            storedAt: Date.now(),
          })
        }
        return { type: DHT_STORE, from: this.#localId, stored: true }

      default:
        return null
    }
  }

  /**
   * Get a value from the local store. Checks TTL expiry.
   * @param {string} key
   * @returns {*|undefined}
   */
  get(key) {
    const entry = this.#store.get(key)
    if (!entry) return undefined
    if (entry.ttl > 0 && Date.now() > entry.storedAt + entry.ttl) {
      this.#store.delete(key)
      return undefined
    }
    return entry.value
  }

  /**
   * Bootstrap the node with seed contacts. Adds each to the routing table,
   * then does a findNode(localId) to populate nearby buckets.
   * @param {Array<{podId: string, address?: string}>} seedContacts
   * @returns {Array<{podId: string, address?: string, lastSeen?: number}>}
   */
  bootstrap(seedContacts) {
    for (const contact of seedContacts) {
      this.#routingTable.addContact({ ...contact, lastSeen: Date.now() })
    }
    return this.findNode(this.#localId)
  }
}

// ---------------------------------------------------------------------------
// GossipProtocol
// ---------------------------------------------------------------------------

/**
 * Epidemic gossip protocol for state dissemination.
 */
export class GossipProtocol {
  /** @type {string} */
  #localId

  /** @type {number} */
  #fanout

  /** @type {number} */
  #interval

  /** @type {Function} */
  #sendFn

  /** @type {Map<string, {value: *, version: number, origin: string}>} */
  #state = new Map()

  /** @type {number} */
  #version = 0

  /** @type {boolean} */
  #active = false

  /** @type {*} */
  #timer = null

  /** @type {string[]} */
  #peers = []

  /**
   * @param {object} opts
   * @param {string} opts.localId - This node's identifier
   * @param {number} [opts.fanout=3] - Number of peers to gossip to per round
   * @param {number} [opts.interval=5000] - Gossip interval in ms
   * @param {Function} [opts.sendFn] - Function to send messages: (targetId, msg) => {}
   */
  constructor({ localId, fanout = 3, interval = 5000, sendFn }) {
    if (!localId || typeof localId !== 'string') {
      throw new Error('localId is required and must be a non-empty string')
    }
    this.#localId = localId
    this.#fanout = fanout
    this.#interval = interval
    this.#sendFn = sendFn ?? (() => {})
  }

  /**
   * Set a local state value. Bumps version and marks origin.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    this.#version++
    this.#state.set(key, { value, version: this.#version, origin: this.#localId })
  }

  /**
   * Get a local state value.
   * @param {string} key
   * @returns {*|undefined}
   */
  get(key) {
    const entry = this.#state.get(key)
    return entry ? entry.value : undefined
  }

  /**
   * Push a digest (version vector) to a target peer.
   * @param {string} targetId
   */
  pushDigest(targetId) {
    const digest = {}
    for (const [key, entry] of this.#state) {
      digest[key] = entry.version
    }
    this.#sendFn(targetId, {
      type: GOSSIP_DIGEST,
      from: this.#localId,
      digest,
    })
  }

  /**
   * Handle a push message with entries. Keep entries with newer versions.
   * @param {string} fromId
   * @param {Array<{key: string, value: *, version: number, origin: string}>} entries
   */
  handlePush(fromId, entries) {
    for (const entry of entries) {
      const local = this.#state.get(entry.key)
      if (!local || entry.version > local.version) {
        this.#state.set(entry.key, {
          value: entry.value,
          version: entry.version,
          origin: entry.origin,
        })
      }
    }
    // Track peer
    if (!this.#peers.includes(fromId)) {
      this.#peers.push(fromId)
    }
  }

  /**
   * Handle a pull request. Compare with local state and send back
   * entries that are newer locally.
   * @param {string} fromId
   * @param {object} digest - key -> version map
   * @returns {Array<{key: string, value: *, version: number, origin: string}>}
   */
  handlePull(fromId, digest) {
    const newer = []
    for (const [key, entry] of this.#state) {
      const remoteVersion = digest[key] ?? 0
      if (entry.version > remoteVersion) {
        newer.push({
          key,
          value: entry.value,
          version: entry.version,
          origin: entry.origin,
        })
      }
    }
    this.#sendFn(fromId, {
      type: GOSSIP_PUSH,
      from: this.#localId,
      entries: newer,
    })
    // Track peer
    if (!this.#peers.includes(fromId)) {
      this.#peers.push(fromId)
    }
    return newer
  }

  /**
   * Handle a digest message. Compare with local state and request
   * missing/newer entries via pull.
   * @param {string} fromId
   * @param {object} digest - key -> version map
   */
  handleDigest(fromId, digest) {
    const localDigest = {}
    for (const [key, entry] of this.#state) {
      localDigest[key] = entry.version
    }

    // Check if remote has anything newer
    let needPull = false
    for (const key of Object.keys(digest)) {
      const localVersion = localDigest[key] ?? 0
      if (digest[key] > localVersion) {
        needPull = true
        break
      }
    }

    if (needPull) {
      this.#sendFn(fromId, {
        type: GOSSIP_PULL,
        from: this.#localId,
        digest: localDigest,
      })
    }

    // Also send our newer entries as a push
    const newer = []
    for (const [key, entry] of this.#state) {
      const remoteVersion = digest[key] ?? 0
      if (entry.version > remoteVersion) {
        newer.push({
          key,
          value: entry.value,
          version: entry.version,
          origin: entry.origin,
        })
      }
    }
    if (newer.length > 0) {
      this.#sendFn(fromId, {
        type: GOSSIP_PUSH,
        from: this.#localId,
        entries: newer,
      })
    }

    // Track peer
    if (!this.#peers.includes(fromId)) {
      this.#peers.push(fromId)
    }
  }

  /**
   * Add a peer to the gossip network.
   * @param {string} peerId
   */
  addPeer(peerId) {
    if (!this.#peers.includes(peerId)) {
      this.#peers.push(peerId)
    }
  }

  /**
   * Start the gossip protocol. Periodically pushes digests to random peers.
   */
  start() {
    if (this.#active) return
    this.#active = true
    this.#timer = setInterval(() => {
      this.#gossipRound()
    }, this.#interval)
    if (this.#timer && typeof this.#timer === 'object' && this.#timer.unref) {
      this.#timer.unref()
    }
  }

  /**
   * Stop the gossip protocol.
   */
  stop() {
    if (!this.#active) return
    this.#active = false
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /**
   * Get a copy of the full state map.
   * @returns {Map<string, {value: *, version: number, origin: string}>}
   */
  getState() {
    return new Map(this.#state)
  }

  /**
   * Whether the gossip protocol is active.
   * @returns {boolean}
   */
  get active() {
    return this.#active
  }

  /**
   * Perform one gossip round: pick `fanout` random peers and push digest.
   * @private
   */
  #gossipRound() {
    if (this.#peers.length === 0) return
    const targets = this.#pickRandom(this.#peers, this.#fanout)
    for (const targetId of targets) {
      this.pushDigest(targetId)
    }
  }

  /**
   * Pick up to `count` random elements from an array.
   * @param {Array} arr
   * @param {number} count
   * @returns {Array}
   * @private
   */
  #pickRandom(arr, count) {
    if (arr.length <= count) return [...arr]
    const shuffled = [...arr]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    return shuffled.slice(0, count)
  }
}

// ---------------------------------------------------------------------------
// DhtDiscoveryStrategy
// ---------------------------------------------------------------------------

/**
 * DHT-backed discovery strategy.
 * Extends DiscoveryStrategy to use Kademlia DHT for peer discovery.
 */
export class DhtDiscoveryStrategy extends DiscoveryStrategy {
  /** @type {DhtNode} */
  #dhtNode

  /** @type {Array<{podId: string}>} */
  #bootstrapContacts

  /**
   * @param {object} opts
   * @param {string} opts.localId - This node's identifier
   * @param {Function} [opts.sendFn] - Function to send messages
   * @param {number} [opts.k=20] - Bucket size
   * @param {Array<{podId: string}>} [opts.bootstrapContacts=[]] - Initial seed contacts
   */
  constructor({ localId, sendFn, k = 20, bootstrapContacts = [] }) {
    super({ type: 'dht' })
    this.#dhtNode = new DhtNode({ localId, sendFn })
    this.#bootstrapContacts = bootstrapContacts
  }

  /** @returns {DhtNode} The underlying DHT node */
  get dhtNode() {
    return this.#dhtNode
  }

  /**
   * Start the DHT discovery strategy.
   * Bootstraps with seed contacts if provided.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.active) return
    if (this.#bootstrapContacts.length > 0) {
      this.#dhtNode.bootstrap(this.#bootstrapContacts)
    }
    this._active = true
  }

  /**
   * Stop the DHT discovery strategy.
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.active) return
    this._active = false
  }

  /**
   * Announce a record by storing it in the DHT.
   * @param {object} record - Record with at least a podId field
   * @returns {Promise<void>}
   */
  async announce(record) {
    if (!this.active) return
    const key = record.podId ?? record.key
    this.#dhtNode.store(key, record)
  }

  /**
   * Query the DHT for a value. Optionally apply a filter.
   * @param {object} [filter]
   * @returns {Promise<Array>}
   */
  async query(filter) {
    if (!this.active) return []
    const results = []

    // If filter has a key/podId, look it up directly
    if (filter && filter.podId) {
      const result = this.#dhtNode.findValue(filter.podId)
      if (result.found) {
        results.push(result.value)
      }
    } else if (filter && filter.key) {
      const result = this.#dhtNode.findValue(filter.key)
      if (result.found) {
        results.push(result.value)
      }
    }

    return results
  }
}
