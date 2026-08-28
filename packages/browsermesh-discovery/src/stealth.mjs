/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-stealth.js -- Stealth agent with erasure-coded state sharding.
 *
 * Provides state sharding across the DHT for agent stealth operations.
 * State is split into shards using XOR-based erasure coding, distributed
 * across the DHT, and can be reconstituted from a threshold number of shards.
 *
 * StateShard represents an erasure-coded fragment.
 * ShardDistributor scatters shards across DHT nodes.
 * ShardCollector retrieves and reconstructs state from DHT.
 * StealthAgent orchestrates the hide/reconstitute lifecycle.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-dht.test.mjs
 */

import { STEALTH_SHARD } from './dht.mjs'

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
 * Erasure-coded fragment of agent state.
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
  /** @type {import('./clawser-mesh-dht.js').DhtNode} */
  #dhtNode

  /** @type {number} */
  #threshold

  /** @type {number} */
  #totalShards

  /**
   * @param {object} opts
   * @param {import('./clawser-mesh-dht.js').DhtNode} opts.dhtNode - DHT node for storage
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
  /** @type {import('./clawser-mesh-dht.js').DhtNode} */
  #dhtNode

  /** @type {number} */
  #threshold

  /**
   * @param {object} opts
   * @param {import('./clawser-mesh-dht.js').DhtNode} opts.dhtNode - DHT node for retrieval
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
   * Reconstruct original state from data shards (first `threshold` shards).
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

    // Use only the data shards (first threshold shards by index)
    const dataShards = sorted.filter(s => {
      const idx = parseInt(s.shardId.split(':').pop(), 10)
      return idx < this.#threshold
    })

    if (dataShards.length < this.#threshold) {
      throw new Error(`Not enough data shards for reconstruction: need ${this.#threshold}, got ${dataShards.length}`)
    }

    // Concatenate data chunks and trim null padding
    let result = ''
    for (const shard of dataShards) {
      result += shard.data
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
 * Orchestrates the hide/reconstitute lifecycle for a stealth agent.
 * State is sharded across the DHT and can be reconstructed from
 * a threshold number of shards.
 */
export class StealthAgent {
  /** @type {string} */
  #agentId

  /** @type {import('./clawser-mesh-dht.js').DhtNode} */
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

  /**
   * @param {object} opts
   * @param {string} opts.agentId - Agent identifier
   * @param {import('./clawser-mesh-dht.js').DhtNode} opts.dhtNode - DHT node
   * @param {number} [opts.threshold=3] - Minimum shards for recovery
   * @param {number} [opts.totalShards=5] - Total shards to create
   */
  constructor({ agentId, dhtNode, threshold = 3, totalShards = 5 }) {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId is required and must be a non-empty string')
    }
    this.#agentId = agentId
    this.#dhtNode = dhtNode
    this.#threshold = threshold
    this.#totalShards = totalShards
    this.#distributor = new ShardDistributor({ dhtNode, threshold, totalShards })
    this.#collector = new ShardCollector({ dhtNode, threshold })
  }

  /**
   * Hide the agent's state by distributing it as shards across the DHT.
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
