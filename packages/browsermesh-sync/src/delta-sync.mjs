/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-delta-sync.js -- Delta-Based Synchronization Protocol.
 *
 * Efficient state synchronization using delta (diff) encoding:
 *
 * - DeltaEntry: a single state change with vector clock causality.
 * - DeltaLog: append-only log of delta entries with compaction.
 * - DeltaEncoder: produces compact diffs between states.
 * - DeltaDecoder: applies delta patches to reconstruct state.
 * - SyncSession: manages a sync session between two peers.
 * - SyncCoordinator: orchestrates delta sync across multiple peers.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-delta-sync.test.mjs
 */

// ---------------------------------------------------------------------------
// Wire Constants
// ---------------------------------------------------------------------------

/** Wire type for delta sync request (pull). */
export const DELTA_SYNC_REQUEST = 0xE0;

/** Wire type for delta sync response (push deltas). */
export const DELTA_SYNC_RESPONSE = 0xE1;

/** Wire type for delta sync acknowledgment. */
export const DELTA_SYNC_ACK = 0xE2;

/** Wire type for full state snapshot (fallback). */
export const DELTA_FULL_SNAPSHOT = 0xE3;

/** Wire type for branch creation. */
export const DELTA_BRANCH_CREATE = 0xE4;

/** Wire type for branch merge. */
export const DELTA_BRANCH_MERGE = 0xE5;

// ---------------------------------------------------------------------------
// DeltaEntry
// ---------------------------------------------------------------------------

let _deltaSeq = 0;

/**
 * A single state change entry in the delta log.
 */
export class DeltaEntry {
  /**
   * @param {object} opts
   * @param {string} [opts.id]         Unique entry ID
   * @param {string} opts.key          State key that changed
   * @param {string} opts.op           Operation: 'set', 'delete', 'merge'
   * @param {*} [opts.value]           New value (for 'set' and 'merge')
   * @param {string} opts.origin       Pod ID that produced this delta
   * @param {number} [opts.seq]        Local sequence number
   * @param {number} [opts.timestamp]  Unix timestamp (ms)
   * @param {Object} [opts.vectorClock] Causal vector clock snapshot
   */
  constructor({
    id,
    key,
    op,
    value,
    origin,
    seq,
    timestamp,
    vectorClock = {},
  }) {
    if (!key || typeof key !== 'string') {
      throw new Error('key is required and must be a non-empty string');
    }
    if (!op || !['set', 'delete', 'merge'].includes(op)) {
      throw new Error('op must be "set", "delete", or "merge"');
    }
    if (!origin || typeof origin !== 'string') {
      throw new Error('origin is required and must be a non-empty string');
    }

    this.id = id || `delta_${Date.now()}_${++_deltaSeq}`;
    this.key = key;
    this.op = op;
    this.value = op === 'delete' ? undefined : value;
    this.origin = origin;
    this.seq = seq ?? ++_deltaSeq;
    this.timestamp = timestamp || Date.now();
    this.vectorClock = { ...vectorClock };
  }

  toJSON() {
    const obj = {
      id: this.id,
      key: this.key,
      op: this.op,
      origin: this.origin,
      seq: this.seq,
      timestamp: this.timestamp,
      vectorClock: { ...this.vectorClock },
    };
    if (this.op !== 'delete') obj.value = this.value;
    return obj;
  }

  static fromJSON(data) {
    return new DeltaEntry(data);
  }
}

// ---------------------------------------------------------------------------
// DeltaLog
// ---------------------------------------------------------------------------

/**
 * Append-only log of delta entries with compaction and slicing.
 */
export class DeltaLog {
  /** @type {DeltaEntry[]} */
  #entries = [];

  /** @type {number} Max entries before auto-compaction (0 = no auto) */
  #maxSize;

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxSize=0] Max entries before auto-compaction
   */
  constructor({ maxSize = 0 } = {}) {
    this.#maxSize = maxSize;
  }

  /** Number of entries. */
  get length() {
    return this.#entries.length;
  }

  /**
   * Append a delta entry.
   * @param {DeltaEntry} entry
   */
  append(entry) {
    this.#entries.push(entry);
    if (this.#maxSize > 0 && this.#entries.length > this.#maxSize) {
      this.compact();
    }
  }

  /**
   * Get entries since a given sequence number (exclusive).
   * @param {number} sinceSeq
   * @returns {DeltaEntry[]}
   */
  since(sinceSeq) {
    return this.#entries.filter(e => e.seq > sinceSeq);
  }

  /**
   * Get entries since a given vector clock.
   * Returns entries not dominated by the provided clock.
   * @param {Object} vclock - { podId: seq }
   * @returns {DeltaEntry[]}
   */
  sinceVectorClock(vclock) {
    return this.#entries.filter(e => {
      const knownSeq = vclock[e.origin] || 0;
      return e.seq > knownSeq;
    });
  }

  /**
   * Compact the log: for each key, keep only the latest entry.
   * @returns {number} Number of entries removed
   */
  compact() {
    const latest = new Map();
    // Iterate in order; later entries override earlier ones
    for (const entry of this.#entries) {
      latest.set(entry.key, entry);
    }
    const before = this.#entries.length;
    this.#entries = [...latest.values()];
    return before - this.#entries.length;
  }

  /** Get all entries (copy). */
  toArray() {
    return [...this.#entries];
  }

  /** Get the latest entry for a specific key. */
  getLatest(key) {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      if (this.#entries[i].key === key) return this.#entries[i];
    }
    return null;
  }

  /** Get the maximum sequence number across all entries. */
  getMaxSeq() {
    let max = 0;
    for (const e of this.#entries) {
      if (e.seq > max) max = e.seq;
    }
    return max;
  }

  /** Build a vector clock from all entries. */
  getVectorClock() {
    const vc = {};
    for (const e of this.#entries) {
      if (!vc[e.origin] || e.seq > vc[e.origin]) {
        vc[e.origin] = e.seq;
      }
    }
    return vc;
  }

  /** Clear all entries. */
  clear() {
    this.#entries = [];
  }

  toJSON() {
    return this.#entries.map(e => e.toJSON());
  }

  static fromJSON(arr) {
    const log = new DeltaLog();
    for (const d of arr) {
      log.append(DeltaEntry.fromJSON(d));
    }
    return log;
  }
}

// ---------------------------------------------------------------------------
// DeltaEncoder
// ---------------------------------------------------------------------------

/**
 * Produces compact delta diffs between two state snapshots.
 */
export class DeltaEncoder {
  /**
   * Compute the delta between oldState and newState.
   * @param {Object} oldState - Previous state (key→value map)
   * @param {Object} newState - Current state (key→value map)
   * @param {string} origin   - Pod ID producing this delta
   * @returns {DeltaEntry[]} Array of delta entries
   */
  encode(oldState, newState, origin) {
    if (!origin || typeof origin !== 'string') {
      throw new Error('origin is required and must be a non-empty string');
    }
    const entries = [];
    const allKeys = new Set([...Object.keys(oldState), ...Object.keys(newState)]);

    for (const key of allKeys) {
      const oldVal = oldState[key];
      const newVal = newState[key];

      if (!(key in newState)) {
        // Key deleted
        entries.push(new DeltaEntry({ key, op: 'delete', origin }));
      } else if (!(key in oldState)) {
        // Key added
        entries.push(new DeltaEntry({ key, op: 'set', value: newVal, origin }));
      } else if (!this._deepEqual(oldVal, newVal)) {
        // Key changed
        if (typeof oldVal === 'object' && typeof newVal === 'object' &&
            oldVal !== null && newVal !== null &&
            !Array.isArray(oldVal) && !Array.isArray(newVal)) {
          // Object merge
          entries.push(new DeltaEntry({ key, op: 'merge', value: newVal, origin }));
        } else {
          entries.push(new DeltaEntry({ key, op: 'set', value: newVal, origin }));
        }
      }
    }

    return entries;
  }

  /**
   * Compute the byte size estimate of a set of entries.
   * @param {DeltaEntry[]} entries
   * @returns {number}
   */
  estimateSize(entries) {
    return entries.reduce((sum, e) => sum + JSON.stringify(e.toJSON()).length, 0);
  }

  /** @private Deep equality check (simple JSON comparison). */
  _deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
}

// ---------------------------------------------------------------------------
// DeltaDecoder
// ---------------------------------------------------------------------------

/**
 * Applies delta patches to reconstruct/update state.
 */
export class DeltaDecoder {
  /**
   * Apply a set of delta entries to a state object.
   * @param {Object} state - Mutable state to update
   * @param {DeltaEntry[]} entries - Deltas to apply
   * @returns {Object} Updated state (same reference)
   */
  apply(state, entries) {
    for (const entry of entries) {
      switch (entry.op) {
        case 'set':
          state[entry.key] = entry.value;
          break;
        case 'delete':
          delete state[entry.key];
          break;
        case 'merge':
          if (typeof state[entry.key] === 'object' && state[entry.key] !== null) {
            state[entry.key] = { ...state[entry.key], ...entry.value };
          } else {
            state[entry.key] = entry.value;
          }
          break;
        default:
          throw new Error(`Unknown delta op: ${entry.op}`);
      }
    }
    return state;
  }

  /**
   * Apply entries in causal order (sort by vector clock).
   * @param {Object} state
   * @param {DeltaEntry[]} entries
   * @returns {Object}
   */
  applyCausal(state, entries) {
    // Sort by timestamp as proxy for causal order
    const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);
    return this.apply(state, sorted);
  }
}

// ---------------------------------------------------------------------------
// DeltaBranch
// ---------------------------------------------------------------------------

/**
 * A parallel state timeline branched from the main sync state.
 * Each branch captures a snapshot at fork point and maintains its
 * own independent delta log.
 */
export class DeltaBranch {
  #name
  #snapshot
  #parentBranch
  #log
  #createdAt

  /**
   * @param {string} name - Branch name
   * @param {Object} snapshotState - State snapshot at fork point
   * @param {string|null} [parentBranch] - Parent branch name (null = main)
   */
  constructor(name, snapshotState, parentBranch = null) {
    if (!name || typeof name !== 'string') {
      throw new Error('Branch name is required and must be a non-empty string')
    }
    this.#name = name
    this.#snapshot = { ...snapshotState }
    this.#parentBranch = parentBranch
    this.#log = new DeltaLog()
    this.#createdAt = Date.now()
  }

  get name() { return this.#name }
  get parentBranch() { return this.#parentBranch }
  get createdAt() { return this.#createdAt }
  get logSize() { return this.#log.length }

  /**
   * Apply a set operation on this branch.
   */
  apply(key, value, origin = 'branch') {
    const entry = new DeltaEntry({
      key,
      op: 'set',
      value,
      origin,
      vectorClock: this.#log.getVectorClock(),
    })
    this.#log.append(entry)
  }

  /**
   * Delete a key on this branch.
   */
  delete(key, origin = 'branch') {
    const entry = new DeltaEntry({
      key,
      op: 'delete',
      origin,
      vectorClock: this.#log.getVectorClock(),
    })
    this.#log.append(entry)
  }

  /**
   * Get the current state of this branch (snapshot + applied deltas).
   */
  getState() {
    const state = { ...this.#snapshot }
    const decoder = new DeltaDecoder()
    return decoder.apply(state, this.#log.toArray())
  }

  /**
   * Compute the diff between this branch and another branch (or state).
   * Returns the set of keys that differ.
   */
  diffFrom(otherBranch) {
    const thisState = this.getState()
    const otherState = otherBranch instanceof DeltaBranch
      ? otherBranch.getState()
      : otherBranch // plain state object

    const allKeys = new Set([...Object.keys(thisState), ...Object.keys(otherState)])
    const changed = []
    for (const key of allKeys) {
      if (JSON.stringify(thisState[key]) !== JSON.stringify(otherState[key])) {
        changed.push({
          key,
          ours: thisState[key],
          theirs: otherState[key],
        })
      }
    }
    return changed
  }

  /**
   * Get the delta log for this branch.
   */
  getLog() {
    return this.#log
  }

  toJSON() {
    return {
      name: this.#name,
      snapshot: { ...this.#snapshot },
      parentBranch: this.#parentBranch,
      log: this.#log.toJSON(),
      createdAt: this.#createdAt,
    }
  }
}

// ---------------------------------------------------------------------------
// SyncSession
// ---------------------------------------------------------------------------

/** @type {readonly string[]} */
const SYNC_STATES = Object.freeze([
  'idle',
  'requesting',
  'receiving',
  'applying',
  'complete',
  'error',
]);

/**
 * Manages a sync session between two peers.
 */
export class SyncSession {
  /** @type {string} */
  #id;
  /** @type {string} */
  #localPodId;
  /** @type {string} */
  #remotePodId;
  /** @type {string} */
  #state = 'idle';
  /** @type {Object} */
  #localClock;
  /** @type {Object} */
  #remoteClock;
  /** @type {DeltaEntry[]} */
  #pendingSend = [];
  /** @type {DeltaEntry[]} */
  #pendingReceive = [];
  /** @type {number} */
  #createdAt;
  /** @type {number} */
  #lastSyncAt = 0;
  /** @type {{ sent: number, received: number, rounds: number }} */
  #stats = { sent: 0, received: 0, rounds: 0 };
  /** @type {Function[]} */
  #stateListeners = [];

  /**
   * @param {object} opts
   * @param {string} [opts.id]
   * @param {string} opts.localPodId
   * @param {string} opts.remotePodId
   * @param {Object} [opts.localClock]  Initial local vector clock
   * @param {Object} [opts.remoteClock] Known remote vector clock
   */
  constructor({ id, localPodId, remotePodId, localClock = {}, remoteClock = {} }) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string');
    }
    if (!remotePodId || typeof remotePodId !== 'string') {
      throw new Error('remotePodId is required and must be a non-empty string');
    }

    this.#id = id || `sync_${localPodId}_${remotePodId}_${Date.now()}`;
    this.#localPodId = localPodId;
    this.#remotePodId = remotePodId;
    this.#localClock = { ...localClock };
    this.#remoteClock = { ...remoteClock };
    this.#createdAt = Date.now();
  }

  get id() { return this.#id; }
  get localPodId() { return this.#localPodId; }
  get remotePodId() { return this.#remotePodId; }
  get state() { return this.#state; }
  get localClock() { return { ...this.#localClock }; }
  get remoteClock() { return { ...this.#remoteClock }; }
  get stats() { return { ...this.#stats }; }
  get lastSyncAt() { return this.#lastSyncAt; }

  /**
   * Prepare outbound deltas from a delta log.
   * @param {DeltaLog} log
   * @returns {DeltaEntry[]}
   */
  prepareSend(log) {
    this._setState('requesting');
    const deltas = log.sinceVectorClock(this.#remoteClock);
    this.#pendingSend = deltas;
    return deltas;
  }

  /**
   * Number of entries waiting to be confirmed as sent.
   * @returns {number}
   */
  get pendingSendCount() {
    return this.#pendingSend.length;
  }

  /**
   * Mark outbound deltas as sent.
   * @param {DeltaEntry[]} sent
   */
  confirmSent(sent) {
    this.#stats.sent += sent.length;
    // Update our knowledge of remote clock
    for (const e of sent) {
      if (!this.#remoteClock[e.origin] || e.seq > this.#remoteClock[e.origin]) {
        this.#remoteClock[e.origin] = e.seq;
      }
    }
    this.#pendingSend = [];
  }

  /**
   * Receive deltas from the remote peer.
   * @param {DeltaEntry[]} entries
   */
  receiveDeltas(entries) {
    this._setState('receiving');
    this.#pendingReceive = entries;
    this.#stats.received += entries.length;
  }

  /**
   * Apply received deltas to local state.
   * @param {Object} state - Mutable state
   * @param {DeltaDecoder} decoder
   * @returns {Object} Updated state
   */
  applyReceived(state, decoder) {
    this._setState('applying');
    const result = decoder.applyCausal(state, this.#pendingReceive);

    // Update local clock
    for (const e of this.#pendingReceive) {
      if (!this.#localClock[e.origin] || e.seq > this.#localClock[e.origin]) {
        this.#localClock[e.origin] = e.seq;
      }
    }

    this.#pendingReceive = [];
    this.#stats.rounds++;
    this.#lastSyncAt = Date.now();
    this._setState('complete');
    return result;
  }

  /** Register state change listener. */
  onStateChange(cb) {
    this.#stateListeners.push(cb);
  }

  /** @private */
  _setState(newState) {
    const old = this.#state;
    this.#state = newState;
    for (const cb of this.#stateListeners) cb(newState, old);
  }

  toJSON() {
    return {
      id: this.#id,
      localPodId: this.#localPodId,
      remotePodId: this.#remotePodId,
      state: this.#state,
      localClock: { ...this.#localClock },
      remoteClock: { ...this.#remoteClock },
      stats: { ...this.#stats },
      lastSyncAt: this.#lastSyncAt,
    };
  }
}

// ---------------------------------------------------------------------------
// SyncCoordinator
// ---------------------------------------------------------------------------

/**
 * Orchestrates delta sync across multiple peers.
 */
export class SyncCoordinator {
  /** @type {string} */
  #localPodId;

  /** @type {DeltaLog} */
  #log;

  /** @type {DeltaEncoder} */
  #encoder;

  /** @type {DeltaDecoder} */
  #decoder;

  /** @type {Map<string, SyncSession>} remotePodId → session */
  #sessions = new Map();

  /** @type {Object} Shared state */
  #state;

  /** @type {Function[]} */
  #syncListeners = [];

  /** @type {Map<string, DeltaBranch>} branchName → DeltaBranch */
  #branches = new Map();

  /**
   * @param {object} opts
   * @param {string} opts.localPodId
   * @param {Object} [opts.initialState={}]
   * @param {DeltaLog} [opts.log]
   */
  /** @type {Function|null} (targetId, msg) => void */
  #sendFn;

  /**
   * @param {object} opts
   * @param {string} opts.localPodId
   * @param {Object} [opts.initialState={}]
   * @param {DeltaLog} [opts.log]
   * @param {Function} [opts.sendFn] Send function: (targetId, msg) => {}
   */
  constructor({ localPodId, initialState = {}, log, sendFn }) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string');
    }
    this.#localPodId = localPodId;
    this.#state = { ...initialState };
    this.#log = log || new DeltaLog();
    this.#encoder = new DeltaEncoder();
    this.#decoder = new DeltaDecoder();
    this.#sendFn = sendFn || null;
  }

  get localPodId() { return this.#localPodId; }
  get state() { return { ...this.#state }; }

  /**
   * Set or replace the send function used for wire protocol messages.
   * Useful when the transport layer is established after construction.
   * @param {Function} fn - (targetId, msg) => void
   */
  setSendFn(fn) {
    this.#sendFn = typeof fn === 'function' ? fn : null;
  }

  /**
   * Apply a local state change.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    const entry = new DeltaEntry({
      key,
      op: 'set',
      value,
      origin: this.#localPodId,
      vectorClock: this.#log.getVectorClock(),
    });
    this.#log.append(entry);
    this.#state[key] = value;
  }

  /**
   * Delete a key from local state.
   * @param {string} key
   */
  delete(key) {
    const entry = new DeltaEntry({
      key,
      op: 'delete',
      origin: this.#localPodId,
      vectorClock: this.#log.getVectorClock(),
    });
    this.#log.append(entry);
    delete this.#state[key];
  }

  /**
   * Get or create a sync session with a remote peer.
   * @param {string} remotePodId
   * @returns {SyncSession}
   */
  getSession(remotePodId) {
    if (!this.#sessions.has(remotePodId)) {
      this.#sessions.set(remotePodId, new SyncSession({
        localPodId: this.#localPodId,
        remotePodId,
        localClock: this.#log.getVectorClock(),
      }));
    }
    return this.#sessions.get(remotePodId);
  }

  /**
   * Prepare deltas to send to a remote peer.
   * @param {string} remotePodId
   * @returns {DeltaEntry[]}
   */
  prepareSyncTo(remotePodId) {
    const session = this.getSession(remotePodId);
    return session.prepareSend(this.#log);
  }

  /**
   * Receive and apply deltas from a remote peer.
   * @param {string} remotePodId
   * @param {DeltaEntry[]} entries
   */
  receiveFrom(remotePodId, entries) {
    const session = this.getSession(remotePodId);
    session.receiveDeltas(entries);
    this.#state = session.applyReceived(this.#state, this.#decoder);

    // Also append to our log for future sync with other peers
    for (const e of entries) {
      this.#log.append(e);
    }

    for (const cb of this.#syncListeners) cb(remotePodId, entries);
  }

  /** Remove a sync session. */
  removeSession(remotePodId) {
    this.#sessions.delete(remotePodId);
  }

  /** List all active sessions. */
  listSessions() {
    return [...this.#sessions.entries()].map(([podId, session]) => ({
      remotePodId: podId,
      state: session.state,
      stats: session.stats,
      lastSyncAt: session.lastSyncAt,
    }));
  }

  /** Get the delta log. */
  getLog() {
    return this.#log;
  }

  /** Register sync listener. */
  onSync(cb) {
    this.#syncListeners.push(cb);
  }

  /**
   * Remove a sync listener.
   * @param {Function} cb
   * @returns {boolean} True if the listener was found and removed
   */
  offSync(cb) {
    const idx = this.#syncListeners.indexOf(cb);
    if (idx !== -1) { this.#syncListeners.splice(idx, 1); return true; }
    return false;
  }

  /** Get stats. */
  getStats() {
    let totalSent = 0;
    let totalReceived = 0;
    let totalRounds = 0;
    for (const s of this.#sessions.values()) {
      const st = s.stats;
      totalSent += st.sent;
      totalReceived += st.received;
      totalRounds += st.rounds;
    }
    return {
      sessionCount: this.#sessions.size,
      logSize: this.#log.length,
      stateKeys: Object.keys(this.#state).length,
      totalSent,
      totalReceived,
      totalRounds,
    };
  }

  // -----------------------------------------------------------------------
  // Branch management (CRDT parallel state timelines)
  // -----------------------------------------------------------------------

  /**
   * Create a new branch with a snapshot of the current state.
   * @param {string} name - Branch name
   * @returns {DeltaBranch}
   */
  createBranch(name) {
    if (this.#branches.has(name)) {
      throw new Error(`Branch "${name}" already exists`);
    }
    const branch = new DeltaBranch(name, this.#state);
    this.#branches.set(name, branch);
    return branch;
  }

  /**
   * List all branches with metadata.
   * @returns {Array<{ name: string, parentBranch: string|null, logSize: number, createdAt: number }>}
   */
  listBranches() {
    return [...this.#branches.values()].map(b => ({
      name: b.name,
      parentBranch: b.parentBranch,
      logSize: b.logSize,
      createdAt: b.createdAt,
    }));
  }

  /**
   * Switch to a branch by applying its state as the current state.
   * @param {string} name - Branch name
   * @returns {Object} The new current state
   */
  switchBranch(name) {
    const branch = this.#branches.get(name);
    if (!branch) {
      throw new Error(`Branch "${name}" does not exist`);
    }
    this.#state = branch.getState();
    return { ...this.#state };
  }

  /**
   * Merge a branch back into the main state.
   * @param {string} name - Branch name
   * @param {'ours'|'theirs'|'fail'} [strategy='ours'] - Conflict resolution strategy
   * @returns {{ merged: number, conflicts: Array<{ key: string, ours: *, theirs: * }> }}
   */
  mergeBranch(name, strategy = 'ours') {
    const branch = this.#branches.get(name);
    if (!branch) {
      throw new Error(`Branch "${name}" does not exist`);
    }

    const branchState = branch.getState();
    const allKeys = new Set([...Object.keys(this.#state), ...Object.keys(branchState)]);
    const conflicts = [];
    let merged = 0;

    for (const key of allKeys) {
      const oursVal = this.#state[key];
      const theirsVal = branchState[key];

      if (JSON.stringify(oursVal) !== JSON.stringify(theirsVal)) {
        conflicts.push({ key, ours: oursVal, theirs: theirsVal });

        if (strategy === 'theirs') {
          if (theirsVal === undefined) {
            delete this.#state[key];
          } else {
            this.#state[key] = theirsVal;
          }
          merged++;
        } else if (strategy === 'fail') {
          // Collect all conflicts first, then throw
          continue;
        } else {
          // 'ours': keep main state value, count as merged
          merged++;
        }
      }
    }

    if (strategy === 'fail' && conflicts.length > 0) {
      const keys = conflicts.map(c => c.key).join(', ');
      throw new Error(`Merge conflict on keys: ${keys}`);
    }

    this.#branches.delete(name);
    return { merged, conflicts };
  }

  /**
   * Delete a branch.
   * @param {string} name - Branch name
   * @returns {boolean} True if the branch existed and was deleted
   */
  deleteBranch(name) {
    return this.#branches.delete(name);
  }

  // -----------------------------------------------------------------------
  // Wire protocol
  // -----------------------------------------------------------------------

  /**
   * Handle an incoming wire message.
   * @param {string} fromId - Sender pod ID
   * @param {object} msg - Message with `type` field
   */
  handleMessage(fromId, msg) {
    switch (msg.type) {
      case DELTA_SYNC_REQUEST: {
        const entries = this.prepareSyncTo(fromId);
        if (this.#sendFn) {
          this.#sendFn(fromId, {
            type: DELTA_SYNC_RESPONSE,
            entries: entries.map(e => e.toJSON()),
          });
        }
        break;
      }

      case DELTA_SYNC_RESPONSE: {
        const entries = (msg.entries || []).map(e =>
          e instanceof DeltaEntry ? e : DeltaEntry.fromJSON(e)
        );
        this.receiveFrom(fromId, entries);
        if (this.#sendFn) {
          this.#sendFn(fromId, {
            type: DELTA_SYNC_ACK,
            entries: (msg.entries || []),
          });
        }
        break;
      }

      case DELTA_SYNC_ACK: {
        const session = this.getSession(fromId);
        if (session.pendingSendCount === 0) break; // no pending send to confirm
        const entries = (msg.entries || []).map(e =>
          e instanceof DeltaEntry ? e : DeltaEntry.fromJSON(e)
        );
        session.confirmSent(entries);
        break;
      }

      case DELTA_FULL_SNAPSHOT: {
        if (msg.state) {
          // Apply as full state replace
          this.#state = { ...msg.state };
        } else if (this.#sendFn) {
          // Send own state snapshot
          this.#sendFn(fromId, {
            type: DELTA_FULL_SNAPSHOT,
            state: { ...this.#state },
          });
        }
        break;
      }

      case DELTA_BRANCH_CREATE: {
        if (msg.name && !this.#branches.has(msg.name)) {
          this.createBranch(msg.name);
        }
        break;
      }

      case DELTA_BRANCH_MERGE: {
        if (msg.name && this.#branches.has(msg.name)) {
          this.mergeBranch(msg.name, msg.strategy || 'ours');
        }
        break;
      }

      default:
        // Unknown message type — ignore
        break;
    }
  }

  /**
   * Initiate a sync by sending DELTA_SYNC_REQUEST to a remote peer.
   * @param {string} remotePodId
   */
  requestSync(remotePodId) {
    if (this.#sendFn) {
      this.#sendFn(remotePodId, { type: DELTA_SYNC_REQUEST });
    }
  }

  /**
   * Broadcast a full state snapshot to listed peers.
   * @param {string[]} peerIds
   */
  broadcastState(peerIds) {
    if (!this.#sendFn) return;
    const snapshot = { ...this.#state };
    for (const peerId of peerIds) {
      this.#sendFn(peerId, {
        type: DELTA_FULL_SNAPSHOT,
        state: snapshot,
      });
    }
  }

  toJSON() {
    return {
      localPodId: this.#localPodId,
      state: { ...this.#state },
      log: this.#log.toJSON(),
      sessions: [...this.#sessions.entries()].map(([k, v]) => ({ remotePodId: k, ...v.toJSON() })),
    };
  }
}
