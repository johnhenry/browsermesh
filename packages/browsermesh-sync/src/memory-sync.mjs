/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-peer-memory-sync.js — CRDT-backed agent memory replication.
 *
 * Replicate agent memory across the mesh using CRDTs. An agent's memory
 * survives device failure — when the user reconnects, memory resyncs
 * from peers. Enables "living personal twin" and "immortal AI swarm".
 *
 * CRDT model: LWW-Element-Map (Last-Writer-Wins per key).
 * Each entry has a key, value, timestamp, podId (origin), and tombstone flag.
 * On merge, timestamps are compared per key. Tombstones with later
 * timestamps win over values with earlier timestamps.
 *
 * Conflict strategies:
 *   - lww: latest timestamp wins (default)
 *   - keep_both: store both under suffixed keys
 *   - ask_user: add to conflicts list, don't auto-resolve
 *   - trust: use podId to look up trust scores
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-memory-sync.test.mjs
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Conflict resolution strategies. */
export const CONFLICT_STRATEGIES = Object.freeze({
  LAST_WRITE_WINS: 'lww',
  TRUST_WEIGHTED: 'trust',
  KEEP_BOTH: 'keep_both',
  ASK_USER: 'ask_user',
})

/** Default configuration values. */
export const MEMORY_SYNC_DEFAULTS = Object.freeze({
  syncIntervalMs: 30_000,
  conflictStrategy: 'lww',
})

// ---------------------------------------------------------------------------
// MemoryEntry
// ---------------------------------------------------------------------------

/**
 * A single entry in the CRDT memory map.
 * Represents one key-value pair with LWW metadata.
 */
export class MemoryEntry {
  /**
   * @param {object} opts
   * @param {string} opts.key - Memory key
   * @param {*} opts.value - Memory value
   * @param {string} [opts.category='core'] - Memory category
   * @param {number} [opts.timestamp] - Unix timestamp in ms
   * @param {string} [opts.podId] - Origin pod ID
   * @param {boolean} [opts.tombstone=false] - Whether entry has been deleted
   */
  constructor({ key, value, category = 'core', timestamp, podId, tombstone = false }) {
    if (!key || typeof key !== 'string') {
      throw new Error('key is required and must be a non-empty string')
    }
    this.key = key
    this.value = value
    this.category = category
    this.timestamp = timestamp || Date.now()
    this.podId = podId || ''
    this.tombstone = Boolean(tombstone)
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      key: this.key,
      value: this.value,
      category: this.category,
      timestamp: this.timestamp,
      podId: this.podId,
      tombstone: this.tombstone,
    }
  }

  /**
   * Deserialize from a plain object.
   * @param {object} json
   * @returns {MemoryEntry}
   */
  static fromJSON(json) {
    return new MemoryEntry({
      key: json.key,
      value: json.value,
      category: json.category,
      timestamp: json.timestamp,
      podId: json.podId,
      tombstone: json.tombstone,
    })
  }
}

// ---------------------------------------------------------------------------
// ConflictEntry
// ---------------------------------------------------------------------------

/**
 * Records a merge conflict between a local and remote MemoryEntry.
 */
export class ConflictEntry {
  /**
   * @param {object} opts
   * @param {string} opts.key - The conflicting key
   * @param {MemoryEntry} opts.local - Local entry
   * @param {MemoryEntry} opts.remote - Remote entry
   * @param {string} opts.strategy - Conflict strategy that was active
   * @param {boolean} [opts.resolved=false] - Whether this conflict has been resolved
   */
  constructor({ key, local, remote, strategy, resolved = false }) {
    this.key = key
    this.local = local
    this.remote = remote
    this.strategy = strategy
    this.resolved = Boolean(resolved)
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      key: this.key,
      local: this.local instanceof MemoryEntry ? this.local.toJSON() : this.local,
      remote: this.remote instanceof MemoryEntry ? this.remote.toJSON() : this.remote,
      strategy: this.strategy,
      resolved: this.resolved,
    }
  }
}

// ---------------------------------------------------------------------------
// SyncResult
// ---------------------------------------------------------------------------

/**
 * Result of a sync or merge operation.
 */
export class SyncResult {
  /**
   * @param {object} opts
   * @param {number} opts.merged - Number of entries merged
   * @param {ConflictEntry[]} opts.conflicts - Conflicts encountered
   * @param {number} [opts.timestamp] - When the sync completed
   */
  constructor({ merged, conflicts, timestamp }) {
    this.merged = merged
    this.conflicts = conflicts || []
    this.timestamp = timestamp || Date.now()
  }
}

// ---------------------------------------------------------------------------
// AgentMemorySync
// ---------------------------------------------------------------------------

/**
 * CRDT-backed agent memory synchronization.
 *
 * Maintains a LWW-Element-Map of agent memory entries, replicates them
 * across the mesh via PeerSession-compatible sessions, and resolves
 * conflicts using configurable strategies.
 */
export class AgentMemorySync {
  /** @type {string} */
  #agentId

  /** @type {object} session with send(type, payload), registerHandler(type, cb), remotePodId */
  #session

  /** @type {Function} */
  #onLog

  /** @type {Map<string, MemoryEntry>} key -> MemoryEntry */
  #state = new Map()

  /** @type {Map<string, Set<Function>>} event -> Set<cb> */
  #listeners = new Map()

  /** @type {boolean} */
  #enabled = false

  /** @type {*} interval ID */
  #syncInterval = null

  /** @type {number} ms between syncs */
  #syncIntervalMs = MEMORY_SYNC_DEFAULTS.syncIntervalMs

  /** @type {string} conflict resolution strategy */
  #conflictStrategy = MEMORY_SYNC_DEFAULTS.conflictStrategy

  /** @type {number|null} timestamp of last successful sync */
  #lastSync = null

  /** @type {MemoryEntry[]} ops waiting to be synced */
  #pendingOps = []

  /** @type {ConflictEntry[]} unresolved conflicts */
  #conflicts = []

  /** @type {Map<string, number>} podId -> trust score (0-1) for trust strategy */
  #trustScores = new Map()

  /**
   * @param {object} opts
   * @param {string} opts.agentId - Identifier for this agent
   * @param {object} opts.session - PeerSession-like object
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   */
  constructor({ agentId, session, onLog }) {
    if (!agentId || typeof agentId !== 'string') {
      throw new Error('agentId is required and must be a non-empty string')
    }
    if (!session || typeof session.send !== 'function') {
      throw new Error('session with send() is required')
    }
    if (!session.registerHandler || typeof session.registerHandler !== 'function') {
      throw new Error('session with registerHandler() is required')
    }

    this.#agentId = agentId
    this.#session = session
    this.#onLog = onLog || (() => {})
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Enable memory sync. Starts periodic sync and registers the
   * session handler for incoming memory-sync messages.
   *
   * @param {object} [opts]
   * @param {number} [opts.syncIntervalMs] - Milliseconds between syncs
   * @param {string} [opts.conflictStrategy] - Conflict resolution strategy
   * @param {Map<string, number>} [opts.trustScores] - Pod trust scores for trust strategy
   */
  enable(opts) {
    if (this.#enabled) return

    if (opts?.syncIntervalMs != null) {
      this.#syncIntervalMs = opts.syncIntervalMs
    }
    if (opts?.conflictStrategy != null) {
      this.#conflictStrategy = opts.conflictStrategy
    }
    if (opts?.trustScores instanceof Map) {
      this.#trustScores = opts.trustScores
    }

    this.#enabled = true

    // Register handler for incoming memory-sync messages
    this.#session.registerHandler('memory-sync', (envelope) => {
      const remoteState = envelope.payload || envelope
      this.#handleRemoteSync(remoteState)
    })

    // Start periodic sync
    this.#syncInterval = setInterval(() => {
      this.syncNow().catch((err) => {
        this.#onLog(0, `Periodic sync failed: ${err.message}`)
      })
    }, this.#syncIntervalMs)

    this.#onLog(2, `Memory sync enabled for agent ${this.#agentId} (interval=${this.#syncIntervalMs}ms)`)
  }

  /**
   * Disable memory sync. Stops interval and removes handler.
   */
  disable() {
    if (!this.#enabled) return

    this.#enabled = false

    if (this.#syncInterval !== null) {
      clearInterval(this.#syncInterval)
      this.#syncInterval = null
    }

    this.#session.removeHandler('memory-sync')
    this.#onLog(2, `Memory sync disabled for agent ${this.#agentId}`)
  }

  // -- Local operations -----------------------------------------------------

  /**
   * Apply a local operation to the CRDT state.
   *
   * @param {object} op
   * @param {string} op.type - 'store' | 'update' | 'forget'
   * @param {string} op.key - Memory key
   * @param {*} [op.value] - Memory value (for store/update)
   * @param {string} [op.category] - Memory category
   * @param {number} [op.timestamp] - Operation timestamp
   */
  applyLocalOp(op) {
    if (!op || !op.key) {
      throw new Error('op.key is required')
    }

    const timestamp = op.timestamp || Date.now()
    const podId = this.#session.remotePodId
      ? `local-${this.#agentId}`
      : this.#agentId

    if (op.type === 'forget') {
      // Create a tombstone entry
      const entry = new MemoryEntry({
        key: op.key,
        value: undefined,
        category: op.category || 'core',
        timestamp,
        podId,
        tombstone: true,
      })
      this.#state.set(op.key, entry)
      this.#pendingOps.push(entry)
      this.#emit('op-applied', { op: 'forget', key: op.key, entry })
    } else {
      // store or update
      const entry = new MemoryEntry({
        key: op.key,
        value: op.value,
        category: op.category || 'core',
        timestamp,
        podId,
        tombstone: false,
      })
      this.#state.set(op.key, entry)
      this.#pendingOps.push(entry)
      this.#emit('op-applied', { op: op.type, key: op.key, entry })
    }
  }

  // -- Sync -----------------------------------------------------------------

  /**
   * Trigger an immediate sync with the remote peer.
   * Sends local state to the peer. The response is handled by the
   * registered 'memory-sync' handler which calls merge().
   *
   * @returns {Promise<SyncResult>}
   */
  async syncNow() {
    const serialized = this.#serializeState()
    this.#session.send('memory-sync', serialized)
    this.#pendingOps = []
    this.#lastSync = Date.now()

    const result = new SyncResult({
      merged: 0,
      conflicts: [],
      timestamp: this.#lastSync,
    })

    this.#emit('synced', result)
    return result
  }

  /**
   * Merge remote state into local state using the configured
   * conflict resolution strategy.
   *
   * @param {object} remoteState - Map-like object or array of MemoryEntry JSON
   * @returns {{ merged: number, conflicts: ConflictEntry[] }}
   */
  merge(remoteState) {
    let merged = 0
    const conflicts = []

    const entries = this.#deserializeRemoteState(remoteState)

    for (const remote of entries) {
      const local = this.#state.get(remote.key)

      if (!local) {
        // No local entry — accept remote unconditionally
        this.#state.set(remote.key, remote)
        merged++
        continue
      }

      // Same timestamp and same podId — skip (identical)
      if (local.timestamp === remote.timestamp && local.podId === remote.podId) {
        continue
      }

      // Apply conflict strategy
      const resolution = this.#resolveEntry(local, remote)

      if (resolution.action === 'accept_remote') {
        this.#state.set(remote.key, remote)
        merged++
      } else if (resolution.action === 'keep_both') {
        // Keep local as-is, store remote under a suffixed key
        const suffixedKey = `${remote.key}__conflict_1`
        const suffixedEntry = new MemoryEntry({
          ...remote.toJSON(),
          key: suffixedKey,
        })
        this.#state.set(suffixedKey, suffixedEntry)
        merged++
      } else if (resolution.action === 'conflict') {
        const conflict = new ConflictEntry({
          key: remote.key,
          local,
          remote,
          strategy: this.#conflictStrategy,
          resolved: false,
        })
        conflicts.push(conflict)
        this.#conflicts.push(conflict)
        this.#emit('conflict', conflict)
      }
      // 'keep_local' — do nothing
    }

    this.#lastSync = Date.now()

    const result = { merged, conflicts }
    if (merged > 0 || conflicts.length > 0) {
      this.#emit('synced', new SyncResult({
        merged,
        conflicts,
        timestamp: this.#lastSync,
      }))
    }

    return result
  }

  // -- Conflict resolution --------------------------------------------------

  /**
   * Manually resolve a pending conflict.
   *
   * @param {string} key - The conflicting key
   * @param {'keep_local'|'keep_remote'|'keep_both'} resolution
   */
  resolveConflict(key, resolution) {
    const idx = this.#conflicts.findIndex((c) => c.key === key && !c.resolved)
    if (idx === -1) {
      throw new Error(`No unresolved conflict for key "${key}"`)
    }

    const conflict = this.#conflicts[idx]
    conflict.resolved = true

    if (resolution === 'keep_remote') {
      this.#state.set(key, conflict.remote)
    } else if (resolution === 'keep_both') {
      // Keep local, store remote under suffixed key
      const suffixedKey = `${key}__conflict_1`
      const suffixedEntry = new MemoryEntry({
        ...conflict.remote.toJSON(),
        key: suffixedKey,
      })
      this.#state.set(suffixedKey, suffixedEntry)
    }
    // 'keep_local' — local already in state, nothing to do
  }

  // -- Queries --------------------------------------------------------------

  /**
   * Return the current CRDT state — all live (non-tombstoned) entries.
   * @returns {Map<string, MemoryEntry>}
   */
  getState() {
    const live = new Map()
    for (const [key, entry] of this.#state) {
      if (!entry.tombstone) {
        live.set(key, entry)
      }
    }
    return live
  }

  /**
   * Return the full internal state including tombstones.
   * @returns {Map<string, MemoryEntry>}
   */
  getFullState() {
    return new Map(this.#state)
  }

  /**
   * Return current sync status.
   * @returns {{ enabled: boolean, lastSync: number|null, pendingOps: number, conflicts: number }}
   */
  getSyncStatus() {
    return {
      enabled: this.#enabled,
      lastSync: this.#lastSync,
      pendingOps: this.#pendingOps.length,
      conflicts: this.#conflicts.filter((c) => !c.resolved).length,
    }
  }

  // -- Events ---------------------------------------------------------------

  /**
   * Register a listener for a sync event.
   * Events: 'synced', 'conflict', 'op-applied'
   *
   * @param {string} event
   * @param {Function} cb
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set())
    }
    this.#listeners.get(event).add(cb)
  }

  /**
   * Remove a listener.
   *
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const set = this.#listeners.get(event)
    if (set) set.delete(cb)
  }

  // -- Serialization --------------------------------------------------------

  /**
   * Serialize the entire sync state to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    const stateEntries = []
    for (const [, entry] of this.#state) {
      stateEntries.push(entry.toJSON())
    }
    return {
      agentId: this.#agentId,
      state: stateEntries,
      conflicts: this.#conflicts.map((c) => c.toJSON()),
      lastSync: this.#lastSync,
      conflictStrategy: this.#conflictStrategy,
      syncIntervalMs: this.#syncIntervalMs,
    }
  }

  /**
   * Restore from a serialized snapshot.
   *
   * @param {object} json - Previously serialized state
   * @param {object} deps - { agentId, session, onLog }
   * @returns {AgentMemorySync}
   */
  static fromJSON(json, deps) {
    const sync = new AgentMemorySync({
      agentId: deps.agentId || json.agentId,
      session: deps.session,
      onLog: deps.onLog,
    })

    // Restore state entries
    if (Array.isArray(json.state)) {
      for (const raw of json.state) {
        const entry = MemoryEntry.fromJSON(raw)
        sync.#state.set(entry.key, entry)
      }
    }

    // Restore conflicts
    if (Array.isArray(json.conflicts)) {
      for (const raw of json.conflicts) {
        sync.#conflicts.push(new ConflictEntry({
          key: raw.key,
          local: MemoryEntry.fromJSON(raw.local),
          remote: MemoryEntry.fromJSON(raw.remote),
          strategy: raw.strategy,
          resolved: raw.resolved,
        }))
      }
    }

    // Restore settings
    if (json.lastSync != null) sync.#lastSync = json.lastSync
    if (json.conflictStrategy) sync.#conflictStrategy = json.conflictStrategy
    if (json.syncIntervalMs != null) sync.#syncIntervalMs = json.syncIntervalMs

    return sync
  }

  // -- Private helpers ------------------------------------------------------

  /**
   * Resolve a conflict between a local and remote entry.
   *
   * @param {MemoryEntry} local
   * @param {MemoryEntry} remote
   * @returns {{ action: 'accept_remote'|'keep_local'|'keep_both'|'conflict' }}
   */
  #resolveEntry(local, remote) {
    switch (this.#conflictStrategy) {
      case CONFLICT_STRATEGIES.LAST_WRITE_WINS:
        return remote.timestamp > local.timestamp
          ? { action: 'accept_remote' }
          : { action: 'keep_local' }

      case CONFLICT_STRATEGIES.KEEP_BOTH:
        return { action: 'keep_both' }

      case CONFLICT_STRATEGIES.ASK_USER:
        return { action: 'conflict' }

      case CONFLICT_STRATEGIES.TRUST_WEIGHTED: {
        const localTrust = this.#trustScores.get(local.podId) ?? 0.5
        const remoteTrust = this.#trustScores.get(remote.podId) ?? 0.5
        if (remoteTrust > localTrust) return { action: 'accept_remote' }
        if (remoteTrust < localTrust) return { action: 'keep_local' }
        // Equal trust — fall back to LWW
        return remote.timestamp > local.timestamp
          ? { action: 'accept_remote' }
          : { action: 'keep_local' }
      }

      default:
        // Unknown strategy — default to LWW
        return remote.timestamp > local.timestamp
          ? { action: 'accept_remote' }
          : { action: 'keep_local' }
    }
  }

  /**
   * Handle an incoming remote sync message.
   * @param {object} remoteState
   */
  #handleRemoteSync(remoteState) {
    try {
      const result = this.merge(remoteState)
      this.#onLog(2, `Merged ${result.merged} entries, ${result.conflicts.length} conflicts`)
    } catch (err) {
      this.#onLog(0, `Error handling remote sync: ${err.message}`)
    }
  }

  /**
   * Serialize the internal state map for transmission.
   * @returns {object[]}
   */
  #serializeState() {
    const entries = []
    for (const [, entry] of this.#state) {
      entries.push(entry.toJSON())
    }
    return entries
  }

  /**
   * Deserialize remote state into MemoryEntry instances.
   *
   * @param {*} remoteState - Array of entry objects, or Map-like
   * @returns {MemoryEntry[]}
   */
  #deserializeRemoteState(remoteState) {
    if (Array.isArray(remoteState)) {
      return remoteState.map((raw) => {
        if (raw instanceof MemoryEntry) return raw
        return MemoryEntry.fromJSON(raw)
      })
    }

    // Object with key->entry pairs
    if (remoteState && typeof remoteState === 'object') {
      return Object.values(remoteState).map((raw) => {
        if (raw instanceof MemoryEntry) return raw
        return MemoryEntry.fromJSON(raw)
      })
    }

    return []
  }

  /**
   * Emit an event to all registered listeners.
   * Uses snapshot iteration so listeners can safely remove themselves.
   *
   * @param {string} event
   * @param {*} data
   */
  #emit(event, data) {
    const set = this.#listeners.get(event)
    if (!set) return
    for (const cb of [...set]) {
      try {
        cb(data)
      } catch {
        /* listener errors do not propagate */
      }
    }
  }
}
