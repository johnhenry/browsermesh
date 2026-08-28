/**
 * clawser-mesh-swarm.js -- Swarm Coordination for BrowserMesh.
 *
 * Leader election, task distribution, and swarm lifecycle management.
 * Peers form a swarm where one node acts as leader, distributing tasks
 * across followers using pluggable strategies.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-swarm.test.mjs
 */

// ---------------------------------------------------------------------------
// Wire Constants — imported from canonical registry
// ---------------------------------------------------------------------------

import { MESH_TYPE } from '@johnhenry/browsermesh-primitives'

export const SWARM_JOIN = MESH_TYPE.SWARM_JOIN
export const SWARM_LEAVE = MESH_TYPE.SWARM_LEAVE
export const SWARM_HEARTBEAT = MESH_TYPE.SWARM_HEARTBEAT
export const SWARM_TASK_ASSIGN = MESH_TYPE.SWARM_TASK_ASSIGN

// SWIM protocol wire types
export const SWIM_PING = 0xF0;
export const SWIM_ACK = 0xF1;
export const SWIM_PING_REQ = 0xF2;
export const SWIM_PING_ACK = 0xF3;

/** @type {readonly string[]} */
export const SWIM_MEMBER_STATES = Object.freeze(['alive', 'suspect', 'dead', 'left']);

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** @type {readonly string[]} */
export const SwarmRole = Object.freeze(['leader', 'follower', 'candidate']);

/** @type {readonly string[]} */
export const TaskStrategy = Object.freeze([
  'leader-follower',
  'round-robin',
  'load-balanced',
  'redundant',
  'pipeline',
]);

/** @type {readonly string[]} */
const TASK_STATUSES = Object.freeze([
  'pending',
  'assigned',
  'running',
  'completed',
  'failed',
]);

// ---------------------------------------------------------------------------
// SwarmMember
// ---------------------------------------------------------------------------

/**
 * Represents a single member of the swarm.
 */
export class SwarmMember {
  /**
   * @param {object} opts
   * @param {string} opts.podId          - Unique identifier for this member
   * @param {string} [opts.role]         - One of SwarmRole
   * @param {number} [opts.load]         - Current load factor 0-1
   * @param {string[]} [opts.capabilities] - Advertised capabilities
   * @param {number} [opts.joinedAt]     - Unix timestamp (ms) when joined
   * @param {number} [opts.lastHeartbeat] - Unix timestamp (ms) of last heartbeat
   */
  constructor({
    podId,
    role = 'candidate',
    load = 0,
    capabilities = [],
    joinedAt = Date.now(),
    lastHeartbeat = Date.now(),
  }) {
    if (!podId || typeof podId !== 'string') {
      throw new Error('podId is required and must be a non-empty string');
    }
    this.podId = podId;
    this.role = role;
    this.load = load;
    this.capabilities = [...capabilities];
    this.joinedAt = joinedAt;
    this.lastHeartbeat = lastHeartbeat;
  }

  /**
   * Whether this member's heartbeat is stale (no heartbeat within timeoutMs).
   *
   * @param {number} [timeoutMs=30000] - Staleness threshold in ms
   * @returns {boolean}
   */
  isStale(timeoutMs = 30000) {
    return (Date.now() - this.lastHeartbeat) > timeoutMs;
  }

  /**
   * Serialize to a plain JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      podId: this.podId,
      role: this.role,
      load: this.load,
      capabilities: [...this.capabilities],
      joinedAt: this.joinedAt,
      lastHeartbeat: this.lastHeartbeat,
    };
  }

  /**
   * Re-hydrate from a plain object.
   * @param {object} data
   * @returns {SwarmMember}
   */
  static fromJSON(data) {
    return new SwarmMember(data);
  }
}

// ---------------------------------------------------------------------------
// SwarmTask
// ---------------------------------------------------------------------------

let _taskCounter = 0;

/**
 * Represents a task to be distributed across swarm members.
 */
export class SwarmTask {
  /**
   * @param {object} opts
   * @param {string} [opts.taskId]        - Unique task identifier
   * @param {string} opts.description     - Human-readable description
   * @param {string} [opts.strategy]      - One of TaskStrategy
   * @param {string[]} [opts.assignedTo]  - podIds assigned to this task
   * @param {string} [opts.status]        - One of TASK_STATUSES
   * @param {*} [opts.input]              - Task input data
   * @param {*} [opts.output]             - Task output data
   * @param {number} [opts.createdAt]     - Unix timestamp (ms)
   * @param {number|null} [opts.startedAt]    - Unix timestamp (ms) when started
   * @param {number|null} [opts.completedAt]  - Unix timestamp (ms) when completed/failed
   */
  constructor({
    taskId = null,
    description,
    strategy = 'leader-follower',
    assignedTo = [],
    status = 'pending',
    input = null,
    output = null,
    createdAt = Date.now(),
    startedAt = null,
    completedAt = null,
  }) {
    if (!description || typeof description !== 'string') {
      throw new Error('description is required and must be a non-empty string');
    }
    this.taskId = taskId || `task_${++_taskCounter}`;
    this.description = description;
    this.strategy = strategy;
    this.assignedTo = [...assignedTo];
    this.status = status;
    this.input = input;
    this.output = output;
    this.createdAt = createdAt;
    this.startedAt = startedAt;
    this.completedAt = completedAt;
  }

  /**
   * Serialize to a plain JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      taskId: this.taskId,
      description: this.description,
      strategy: this.strategy,
      assignedTo: [...this.assignedTo],
      status: this.status,
      input: this.input,
      output: this.output,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
    };
  }

  /**
   * Re-hydrate from a plain object.
   * @param {object} data
   * @returns {SwarmTask}
   */
  static fromJSON(data) {
    return new SwarmTask(data);
  }
}

// ---------------------------------------------------------------------------
// LeaderElection
// ---------------------------------------------------------------------------

/**
 * Deterministic leader election using lowest-lexicographic-podId.
 * Tracks heartbeats to detect stale leaders and trigger re-election.
 */
export class LeaderElection {
  /** @type {string} */
  #localPodId;

  /** @type {Set<string>} */
  #candidates = new Set();

  /** @type {string|null} */
  #leader = null;

  /** @type {Map<string, number>} podId -> last heartbeat timestamp */
  #heartbeats = new Map();

  /** @type {number} */
  #heartbeatMs;

  /** @type {number} */
  #electionTimeoutMs;

  /**
   * @param {string} localPodId
   * @param {object} [opts]
   * @param {number} [opts.heartbeatMs=5000]
   * @param {number} [opts.electionTimeoutMs=15000]
   */
  constructor(localPodId, opts = {}) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string');
    }
    this.#localPodId = localPodId;
    this.#heartbeatMs = opts.heartbeatMs ?? 5000;
    this.#electionTimeoutMs = opts.electionTimeoutMs ?? 15000;
    this.#candidates.add(localPodId);
    this.#heartbeats.set(localPodId, Date.now());
  }

  /** @returns {string|null} Current leader podId or null */
  get leader() {
    return this.#leader;
  }

  /**
   * Current role of the local pod.
   * @returns {string} One of SwarmRole values
   */
  get role() {
    if (this.#leader === this.#localPodId) return 'leader';
    if (this.#leader !== null) return 'follower';
    return 'candidate';
  }

  /** @returns {string} The local podId */
  get localPodId() {
    return this.#localPodId;
  }

  /**
   * Add a candidate to the election pool.
   * @param {string} podId
   */
  addCandidate(podId) {
    this.#candidates.add(podId);
    if (!this.#heartbeats.has(podId)) {
      this.#heartbeats.set(podId, Date.now());
    }
  }

  /**
   * Remove a candidate from the election pool.
   * If the removed candidate was the leader, leader is cleared.
   *
   * @param {string} podId
   * @returns {boolean} true if the candidate existed
   */
  removeCandidate(podId) {
    const existed = this.#candidates.delete(podId);
    this.#heartbeats.delete(podId);
    if (this.#leader === podId) {
      this.#leader = null;
    }
    return existed;
  }

  /**
   * Run an election. The candidate with the lowest lexicographic podId wins.
   *
   * @returns {string} The elected leader's podId
   */
  elect() {
    const sorted = [...this.#candidates].sort();
    if (sorted.length === 0) {
      throw new Error('No candidates available for election');
    }
    this.#leader = sorted[0];
    return this.#leader;
  }

  /**
   * Record a heartbeat from a peer.
   *
   * @param {string} fromPodId
   * @param {number} [timestamp] - Defaults to Date.now()
   */
  receiveHeartbeat(fromPodId, timestamp) {
    this.#heartbeats.set(fromPodId, timestamp ?? Date.now());
  }

  /**
   * Check if the current leader is still alive (has sent a heartbeat
   * within electionTimeoutMs).
   *
   * @param {number} [now] - Current timestamp for testing
   * @returns {boolean} true if leader is alive, false if stale or no leader
   */
  checkLeaderAlive(now) {
    if (!this.#leader) return false;
    const ts = now ?? Date.now();
    const lastHb = this.#heartbeats.get(this.#leader);
    if (lastHb === undefined) return false;
    return (ts - lastHb) <= this.#electionTimeoutMs;
  }

  /**
   * Yield leadership to the next candidate in lexicographic order.
   * Returns the new leader or null if no other candidates exist.
   *
   * @returns {string|null}
   */
  yieldLeadership() {
    const sorted = [...this.#candidates].sort();
    if (sorted.length <= 1) {
      this.#leader = null;
      return null;
    }
    const currentIdx = sorted.indexOf(this.#leader);
    const nextIdx = (currentIdx + 1) % sorted.length;
    this.#leader = sorted[nextIdx];
    return this.#leader;
  }

  /**
   * Get all current candidates sorted lexicographically.
   * @returns {string[]}
   */
  get candidates() {
    return [...this.#candidates].sort();
  }

  /**
   * Serialize to a plain JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      localPodId: this.#localPodId,
      leader: this.#leader,
      candidates: [...this.#candidates],
      heartbeats: Object.fromEntries(this.#heartbeats),
      heartbeatMs: this.#heartbeatMs,
      electionTimeoutMs: this.#electionTimeoutMs,
    };
  }

  /**
   * Re-hydrate from a plain object.
   * @param {object} data
   * @returns {LeaderElection}
   */
  static fromJSON(data) {
    const el = new LeaderElection(data.localPodId, {
      heartbeatMs: data.heartbeatMs,
      electionTimeoutMs: data.electionTimeoutMs,
    });
    // Remove default local candidate, restore serialized set
    el.#candidates.clear();
    for (const c of data.candidates) {
      el.#candidates.add(c);
    }
    el.#leader = data.leader;
    el.#heartbeats.clear();
    for (const [k, v] of Object.entries(data.heartbeats)) {
      el.#heartbeats.set(k, v);
    }
    return el;
  }
}

// ---------------------------------------------------------------------------
// TaskDistributor
// ---------------------------------------------------------------------------

/**
 * Distributes tasks to swarm members based on pluggable strategies.
 */
export class TaskDistributor {
  /** @type {Map<string, SwarmMember>} podId -> SwarmMember */
  #members = new Map();

  /** @type {number} Round-robin index tracker */
  #rrIndex = 0;

  /**
   * @param {SwarmMember[]} [members]
   */
  constructor(members = []) {
    for (const m of members) {
      this.#members.set(m.podId, m);
    }
  }

  /**
   * Add a member to the distributor pool.
   * @param {SwarmMember} member
   */
  addMember(member) {
    this.#members.set(member.podId, member);
  }

  /**
   * Remove a member from the pool.
   * @param {string} podId
   * @returns {boolean}
   */
  removeMember(podId) {
    return this.#members.delete(podId);
  }

  /**
   * Get a member by podId.
   * @param {string} podId
   * @returns {SwarmMember|null}
   */
  getMember(podId) {
    return this.#members.get(podId) || null;
  }

  /**
   * All members as an array.
   * @returns {SwarmMember[]}
   */
  get members() {
    return [...this.#members.values()];
  }

  /** @returns {number} */
  get size() {
    return this.#members.size;
  }

  /**
   * Distribute a task to members using the given strategy.
   * Returns an array of assigned podIds.
   *
   * Strategies:
   *  - leader-follower: assigns to the first member (by insertion order)
   *  - round-robin: rotates through members cyclically
   *  - load-balanced: picks the member with the lowest load
   *  - redundant: assigns to ALL members
   *  - pipeline: assigns to all members in order (same as redundant, semantically different)
   *
   * @param {SwarmTask} task
   * @param {string} [strategy] - Override task's strategy
   * @returns {string[]} Assigned podIds
   */
  distribute(task, strategy) {
    const strat = strategy || task.strategy || 'leader-follower';
    const all = [...this.#members.values()];

    if (all.length === 0) return [];

    switch (strat) {
      case 'leader-follower': {
        const assigned = [all[0].podId];
        task.assignedTo = assigned;
        task.status = 'assigned';
        return assigned;
      }

      case 'round-robin': {
        const idx = this.#rrIndex % all.length;
        this.#rrIndex++;
        const assigned = [all[idx].podId];
        task.assignedTo = assigned;
        task.status = 'assigned';
        return assigned;
      }

      case 'load-balanced': {
        const sorted = [...all].sort((a, b) => a.load - b.load);
        const assigned = [sorted[0].podId];
        task.assignedTo = assigned;
        task.status = 'assigned';
        return assigned;
      }

      case 'redundant': {
        const assigned = all.map(m => m.podId);
        task.assignedTo = assigned;
        task.status = 'assigned';
        return assigned;
      }

      case 'pipeline': {
        const assigned = all.map(m => m.podId);
        task.assignedTo = assigned;
        task.status = 'assigned';
        return assigned;
      }

      default:
        throw new Error(`Unknown task strategy: ${strat}`);
    }
  }
}

// ---------------------------------------------------------------------------
// SwarmCoordinator
// ---------------------------------------------------------------------------

/**
 * High-level facade for swarm management: joining/leaving, leader election,
 * task submission and lifecycle.
 *
 * Internally tracks a `Map<swarmId, {election, distributor, tasks}>` so a
 * single pod can participate in more than one concurrent swarm. `'local'`
 * is the default/legacy swarm — every method that doesn't take an explicit
 * `swarmId` operates on it, so single-swarm callers (all production
 * call-sites and every pre-multi-swarm test) see IDENTICAL behavior to
 * before this refactor. No wire format changed: there's no wireTransport()
 * on this class today (the SWARM_* constants are unused re-exports — see
 * the file header), so there's nothing to add a swarmId field to yet;
 * that's a separate, not-yet-written wire integration.
 */
export class SwarmCoordinator {
  /** @type {string} */
  #localPodId;

  /** @type {Map<string, {election: LeaderElection, distributor: TaskDistributor, tasks: Map<string, SwarmTask>}>} */
  #swarms = new Map();

  /** @type {object} Election opts (heartbeatMs, electionTimeoutMs) applied to every swarm created after construction */
  #electionOpts;

  /** @type {SwimMembership|null} */
  #swim = null;

  /**
   * @param {string} localPodId
   * @param {object} [opts]
   * @param {number} [opts.heartbeatMs]
   * @param {number} [opts.electionTimeoutMs]
   * @param {SwimMembership} [opts.swim] - Optional SWIM membership protocol instance
   */
  constructor(localPodId, opts = {}) {
    this.#localPodId = localPodId;
    this.#electionOpts = opts;
    this.#createSwarm('local');

    // Wire up SWIM membership protocol if provided. SWIM tracks failure
    // detection for the local pod's default swarm only — join/leave here
    // default to 'local', matching pre-multi-swarm behavior.
    this.#swim = opts.swim ?? null;
    if (this.#swim) {
      this.#swim.onJoin = (podId) => this.join(podId);
      this.#swim.onDead = (podId) => this.leave(podId);
    }
  }

  /**
   * Create a new swarm state bundle, adding the local pod as its first
   * member (mirrors the constructor's original single-swarm setup).
   * @param {string} swarmId
   * @returns {{election: LeaderElection, distributor: TaskDistributor, tasks: Map<string, SwarmTask>}}
   */
  #createSwarm(swarmId) {
    const election = new LeaderElection(this.#localPodId, this.#electionOpts);
    const distributor = new TaskDistributor();
    distributor.addMember(new SwarmMember({ podId: this.#localPodId }));
    const swarm = { election, distributor, tasks: new Map() };
    this.#swarms.set(swarmId, swarm);
    return swarm;
  }

  /**
   * Get a swarm's state bundle, auto-creating it (with the local pod as
   * its first member) if it doesn't exist yet — mirrors how the original
   * single-swarm constructor always had exactly one ready-to-use swarm.
   * @param {string} [swarmId='local']
   */
  #getSwarm(swarmId = 'local') {
    return this.#swarms.get(swarmId) || this.#createSwarm(swarmId);
  }

  /**
   * Explicitly create a swarm without joining any extra members yet.
   * Idempotent — returns the existing swarm's state if already present.
   * @param {string} swarmId
   * @returns {boolean} true if a new swarm was created, false if it already existed
   */
  createSwarm(swarmId) {
    if (this.#swarms.has(swarmId)) return false;
    this.#createSwarm(swarmId);
    return true;
  }

  /**
   * Disband a swarm and discard its state (members, election, tasks).
   * The `'local'` swarm can't be disbanded — it's the coordinator's
   * always-available default, matching every single-swarm call-site.
   *
   * @param {string} swarmId
   * @returns {boolean} true if the swarm existed and was removed
   */
  disbandSwarm(swarmId) {
    if (swarmId === 'local') {
      throw new Error("cannot disband the 'local' swarm");
    }
    return this.#swarms.delete(swarmId);
  }

  /** @param {string} swarmId @returns {boolean} */
  hasSwarm(swarmId) {
    return this.#swarms.has(swarmId);
  }

  /**
   * List all tracked swarms with a summary of their state.
   * @returns {Array<{swarmId: string, size: number, isLeader: boolean, leader: string|null, taskCount: number}>}
   */
  listSwarms() {
    return [...this.#swarms.entries()].map(([swarmId, swarm]) => ({
      swarmId,
      size: swarm.distributor.size,
      isLeader: swarm.election.role === 'leader',
      leader: swarm.election.leader,
      taskCount: swarm.tasks.size,
    }));
  }

  /** @returns {LeaderElection} The 'local' swarm's election (unchanged accessor) */
  get election() {
    return this.#getSwarm('local').election;
  }

  /** @returns {TaskDistributor} The 'local' swarm's distributor (unchanged accessor) */
  get distributor() {
    return this.#getSwarm('local').distributor;
  }

  /** @returns {SwimMembership|null} */
  get swim() {
    return this.#swim;
  }

  /**
   * List member podIds of a swarm (defaults to 'local').
   * @param {string} [swarmId='local']
   * @returns {string[]}
   */
  listMembers(swarmId = 'local') {
    return (this.#swarms.get(swarmId)?.distributor.members ?? []).map(m => m.podId);
  }

  /**
   * Add a new member to a swarm (defaults to 'local' — unchanged
   * behavior for every pre-multi-swarm call-site).
   *
   * @param {string} podId
   * @param {string[]} [capabilities]
   * @param {string} [swarmId='local']
   * @returns {SwarmMember}
   */
  join(podId, capabilities = [], swarmId = 'local') {
    const swarm = this.#getSwarm(swarmId);
    const member = new SwarmMember({ podId, capabilities });
    swarm.distributor.addMember(member);
    swarm.election.addCandidate(podId);
    if (swarmId === 'local' && this.#swim) {
      this.#swim.addMember(podId);
    }
    return member;
  }

  /**
   * Remove a member from a swarm (defaults to 'local').
   *
   * @param {string} podId
   * @param {string} [swarmId='local']
   * @returns {boolean}
   */
  leave(podId, swarmId = 'local') {
    const swarm = this.#swarms.get(swarmId);
    if (!swarm) return false;
    swarm.election.removeCandidate(podId);
    if (swarmId === 'local' && this.#swim) {
      this.#swim.removeMember(podId);
    }
    return swarm.distributor.removeMember(podId);
  }

  /**
   * Submit a new task to a swarm (defaults to 'local').
   * The task is created, distributed, and stored.
   *
   * @param {string} description
   * @param {string} [strategy]
   * @param {*} [input]
   * @param {string} [swarmId='local']
   * @returns {SwarmTask}
   */
  submitTask(description, strategy, input, swarmId = 'local') {
    const swarm = this.#getSwarm(swarmId);
    const task = new SwarmTask({
      description,
      strategy: strategy || 'leader-follower',
      input: input ?? null,
    });
    swarm.distributor.distribute(task);
    swarm.tasks.set(task.taskId, task);
    return task;
  }

  /**
   * Find a task by ID across all swarms. Task IDs are unique per
   * coordinator (module-level counter), so no swarmId is needed.
   * @param {string} taskId
   * @returns {SwarmTask|null}
   */
  getTask(taskId) {
    for (const swarm of this.#swarms.values()) {
      const task = swarm.tasks.get(taskId);
      if (task) return task;
    }
    return null;
  }

  /**
   * Mark a task as completed.
   *
   * @param {string} taskId
   * @param {*} [output]
   * @returns {boolean} true if the task was found and completed
   */
  completeTask(taskId, output) {
    const task = this.getTask(taskId);
    if (!task) return false;
    task.status = 'completed';
    task.output = output ?? null;
    task.completedAt = Date.now();
    return true;
  }

  /**
   * Mark a task as failed.
   *
   * @param {string} taskId
   * @param {*} [error]
   * @returns {boolean} true if the task was found and marked failed
   */
  failTask(taskId, error) {
    const task = this.getTask(taskId);
    if (!task) return false;
    task.status = 'failed';
    task.output = error ?? null;
    task.completedAt = Date.now();
    return true;
  }

  /**
   * Cancel a pending or assigned task.
   *
   * @param {string} taskId
   * @returns {boolean} true if the task was found and cancelled
   */
  cancelTask(taskId) {
    const task = this.getTask(taskId);
    if (!task) return false;
    if (task.status === 'completed' || task.status === 'failed') return false;
    task.status = 'cancelled';
    task.completedAt = Date.now();
    return true;
  }

  /**
   * List tasks, optionally filtering by status and/or swarm. Defaults to
   * the 'local' swarm — unchanged behavior for pre-multi-swarm callers,
   * since they only ever submit tasks to 'local'. Pass `swarmId: null`
   * (or any falsy-but-explicit value doesn't work — use the string
   * `'*'`) to list across every swarm.
   *
   * @param {object} [opts]
   * @param {string} [opts.status] - Filter by task status
   * @param {string} [opts.swarmId='local'] - Which swarm to list from, or '*' for all swarms
   * @returns {SwarmTask[]}
   */
  listTasks(opts = {}) {
    const swarmId = opts.swarmId ?? 'local';
    let tasks;
    if (swarmId === '*') {
      tasks = [...this.#swarms.values()].flatMap(s => [...s.tasks.values()]);
    } else {
      tasks = [...(this.#swarms.get(swarmId)?.tasks.values() ?? [])];
    }
    if (opts.status) {
      tasks = tasks.filter(t => t.status === opts.status);
    }
    return tasks;
  }

  /** @returns {number} Number of members in the 'local' swarm (unchanged accessor) */
  get swarmSize() {
    return this.#getSwarm('local').distributor.size;
  }

  /** @returns {boolean} true if the local pod is the elected leader of the 'local' swarm (unchanged accessor) */
  get isLeader() {
    return this.#getSwarm('local').election.role === 'leader';
  }
}

// ---------------------------------------------------------------------------
// SwimMembership — SWIM protocol (Scalable Weakly-consistent Infection-style
// Membership) for failure detection and membership dissemination.
// ---------------------------------------------------------------------------

/**
 * Implements the SWIM protocol for decentralised failure detection.
 *
 * Each tick the local node pings a random peer. If the peer does not
 * respond within `pingTimeoutMs`, indirect pings are sent through `k`
 * random intermediaries.  If the target still does not respond it is
 * marked *suspect*, and after `suspectTimeoutMs` it is declared *dead*.
 *
 * Membership updates (join, suspect, dead, leave) are piggybacked on
 * every ping/ack message so they disseminate in O(log n) rounds.
 */
export class SwimMembership {
  /** @type {string} */
  #localId;

  /** @type {function} */
  #sendFn;

  /** @type {Map<string, {state: string, incarnation: number, suspectAt: number|null}>} */
  #members = new Map();

  /** @type {number} */
  #localIncarnation = 0;

  /** @type {string[]} */
  #pingQueue = [];

  /** @type {Map<number, {targetId: string, timer: *}>} seq -> pending info */
  #pendingPings = new Map();

  /** @type {Array<{podId: string, state: string, incarnation: number}>} */
  #updateBuffer = [];

  /** @type {*} */
  #timer = null;

  /** @type {number} */
  #seqCounter = 0;

  /** @type {number} */
  #pingIntervalMs;

  /** @type {number} */
  #pingTimeoutMs;

  /** @type {number} */
  #suspectTimeoutMs;

  /** @type {number} */
  #indirectPingCount;

  /** @type {function|null} */
  onJoin;

  /** @type {function|null} */
  onSuspect;

  /** @type {function|null} */
  onDead;

  /** @type {function|null} */
  onLeave;

  /** @type {function} */
  #nowFn;

  /**
   * @param {object} opts
   * @param {string} opts.localId             - This node's pod ID
   * @param {function} opts.sendFn            - (targetId, msg) => void
   * @param {number} [opts.pingIntervalMs=1000]
   * @param {number} [opts.pingTimeoutMs=500]
   * @param {number} [opts.suspectTimeoutMs=5000]
   * @param {number} [opts.indirectPingCount=3]
   * @param {function|null} [opts.onJoin]
   * @param {function|null} [opts.onSuspect]
   * @param {function|null} [opts.onDead]
   * @param {function|null} [opts.onLeave]
   * @param {function} [opts.nowFn=Date.now]
   */
  constructor({
    localId,
    sendFn,
    pingIntervalMs = 1000,
    pingTimeoutMs = 500,
    suspectTimeoutMs = 5000,
    indirectPingCount = 3,
    onJoin = null,
    onSuspect = null,
    onDead = null,
    onLeave = null,
    nowFn = Date.now,
  }) {
    if (!localId || typeof localId !== 'string') {
      throw new Error('localId is required and must be a non-empty string');
    }
    if (typeof sendFn !== 'function') {
      throw new Error('sendFn is required and must be a function');
    }
    this.#localId = localId;
    this.#sendFn = sendFn;
    this.#pingIntervalMs = pingIntervalMs;
    this.#pingTimeoutMs = pingTimeoutMs;
    this.#suspectTimeoutMs = suspectTimeoutMs;
    this.#indirectPingCount = indirectPingCount;
    this.onJoin = onJoin;
    this.onSuspect = onSuspect;
    this.onDead = onDead;
    this.onLeave = onLeave;
    this.#nowFn = nowFn;

    // Add self as the first alive member
    this.#members.set(localId, { state: 'alive', incarnation: 0, suspectAt: null });
  }

  /** @returns {string} */
  get localId() {
    return this.#localId;
  }

  /** @returns {number} Total member count */
  get size() {
    return this.#members.size;
  }

  /** @returns {number} Count of alive members */
  get aliveCount() {
    let count = 0;
    for (const entry of this.#members.values()) {
      if (entry.state === 'alive') count++;
    }
    return count;
  }

  /**
   * Begin periodic ping rounds.
   */
  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#pingRound(), this.#pingIntervalMs);
  }

  /**
   * Stop the protocol — clear interval, pending ping timers, and suspect timers.
   */
  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    for (const pending of this.#pendingPings.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.#pendingPings.clear();
  }

  /**
   * Add a member as alive with incarnation 0.
   *
   * @param {string} podId
   */
  addMember(podId) {
    if (podId === this.#localId) return;
    if (this.#members.has(podId)) return;
    this.#members.set(podId, { state: 'alive', incarnation: 0, suspectAt: null });
    this.#enqueueUpdate({ podId, state: 'alive', incarnation: 0 });
    if (this.onJoin) this.onJoin(podId);
  }

  /**
   * Mark a member as left, enqueue a leave update, and invoke the onLeave callback.
   *
   * @param {string} podId
   */
  removeMember(podId) {
    const entry = this.#members.get(podId);
    if (!entry) return;
    entry.state = 'left';
    entry.suspectAt = null;
    this.#enqueueUpdate({ podId, state: 'left', incarnation: entry.incarnation });
    if (this.onLeave) this.onLeave(podId);
  }

  /**
   * Return the state of a member, or null if unknown.
   *
   * @param {string} podId
   * @returns {string|null}
   */
  getState(podId) {
    const entry = this.#members.get(podId);
    return entry ? entry.state : null;
  }

  /**
   * Return a copy of the full membership map.
   *
   * @returns {Map<string, {state: string, incarnation: number, suspectAt: number|null}>}
   */
  getMembers() {
    return new Map(this.#members);
  }

  /**
   * Return an array of pod IDs whose state is 'alive'.
   *
   * @returns {string[]}
   */
  aliveMembers() {
    const result = [];
    for (const [podId, entry] of this.#members) {
      if (entry.state === 'alive') result.push(podId);
    }
    return result;
  }

  /**
   * Dispatch an incoming SWIM message to the appropriate handler.
   *
   * @param {string} fromId - Sender pod ID
   * @param {object} msg    - Wire message
   */
  handleMessage(fromId, msg) {
    switch (msg.type) {
      case SWIM_PING:
        this.#handlePing(fromId, msg);
        break;
      case SWIM_ACK:
        this.#handleAck(fromId, msg);
        break;
      case SWIM_PING_REQ:
        this.#handlePingReq(fromId, msg);
        break;
      case SWIM_PING_ACK:
        this.#handlePingAck(fromId, msg);
        break;
    }
  }

  /**
   * Serialize for inspection.
   *
   * @returns {object}
   */
  toJSON() {
    const members = {};
    for (const [podId, entry] of this.#members) {
      members[podId] = { ...entry };
    }
    return {
      localId: this.#localId,
      localIncarnation: this.#localIncarnation,
      members,
      updateBufferSize: this.#updateBuffer.length,
    };
  }

  // -------------------------------------------------------------------------
  // Private — ping round
  // -------------------------------------------------------------------------

  /**
   * Pick the next target from a shuffled queue and send a SWIM_PING
   * with piggybacked updates.  Start an ack timer.
   */
  #pingRound() {
    if (this.#pingQueue.length === 0) {
      this.#refillPingQueue();
    }
    if (this.#pingQueue.length === 0) return; // no peers

    const targetId = this.#pingQueue.shift();
    const entry = this.#members.get(targetId);
    if (!entry || entry.state === 'dead' || entry.state === 'left') return;

    const seq = ++this.#seqCounter;
    const updates = this.#drainUpdates();

    this.#sendFn(targetId, {
      type: SWIM_PING,
      from: this.#localId,
      seq,
      updates,
    });

    const timer = setTimeout(() => this.#onPingTimeout(targetId, seq), this.#pingTimeoutMs);
    this.#pendingPings.set(seq, { targetId, timer });
  }

  // -------------------------------------------------------------------------
  // Private — message handlers
  // -------------------------------------------------------------------------

  /**
   * Handle an incoming SWIM_PING: process piggybacked updates and reply
   * with a SWIM_ACK carrying our own updates.
   *
   * @param {string} fromId
   * @param {object} msg
   */
  #handlePing(fromId, msg) {
    if (msg.updates) {
      for (const u of msg.updates) this.#processUpdate(u);
    }
    const updates = this.#drainUpdates();
    this.#sendFn(fromId, {
      type: SWIM_ACK,
      from: this.#localId,
      seq: msg.seq,
      updates,
    });
  }

  /**
   * Handle an incoming SWIM_ACK: clear the pending ping timer and process
   * piggybacked updates.
   *
   * @param {string} fromId
   * @param {object} msg
   */
  #handleAck(fromId, msg) {
    const pending = this.#pendingPings.get(msg.seq);
    if (pending) {
      clearTimeout(pending.timer);
      this.#pendingPings.delete(msg.seq);
    }
    if (msg.updates) {
      for (const u of msg.updates) this.#processUpdate(u);
    }
  }

  /**
   * Handle a SWIM_PING_REQ: ping the target on behalf of the requester.
   *
   * @param {string} fromId
   * @param {object} msg
   */
  #handlePingReq(fromId, msg) {
    const seq = ++this.#seqCounter;
    const updates = this.#drainUpdates();

    this.#sendFn(msg.target, {
      type: SWIM_PING,
      from: this.#localId,
      seq,
      updates,
    });

    // When the ack comes back, forward it as SWIM_PING_ACK
    const timer = setTimeout(() => {
      this.#pendingPings.delete(seq);
      // Target didn't respond — notify requester with empty ack
      this.#sendFn(fromId, {
        type: SWIM_PING_ACK,
        from: this.#localId,
        target: msg.target,
        originalFrom: fromId,
        seq: msg.seq,
        updates: [],
      });
    }, this.#pingTimeoutMs);

    this.#pendingPings.set(seq, {
      targetId: msg.target,
      timer,
      // Stash requester info so #handleAck can forward
      indirectFor: { originalFrom: fromId, originalSeq: msg.seq },
    });
  }

  /**
   * Handle a SWIM_PING_ACK: the indirect ping succeeded — clear the
   * indirect timeout for the target.
   *
   * @param {string} fromId
   * @param {object} msg
   */
  #handlePingAck(fromId, msg) {
    // Clear pending indirect timeout for this target
    const pending = this.#pendingPings.get(msg.seq);
    if (pending) {
      clearTimeout(pending.timer);
      this.#pendingPings.delete(msg.seq);
    }
    if (msg.updates) {
      for (const u of msg.updates) this.#processUpdate(u);
    }
  }

  // -------------------------------------------------------------------------
  // Private — timeouts
  // -------------------------------------------------------------------------

  /**
   * Called when a direct ping times out.  Send SWIM_PING_REQ to k random
   * alive members and start an indirect timeout.
   *
   * @param {string} targetId
   * @param {number} seq
   */
  #onPingTimeout(targetId, seq) {
    this.#pendingPings.delete(seq);

    // Pick k random alive peers (excluding self and target) to relay
    const candidates = this.aliveMembers().filter(id => id !== targetId && id !== this.#localId);
    const relays = this.#pickRandom(candidates, this.#indirectPingCount);

    if (relays.length === 0) {
      // No intermediaries — go straight to suspect
      this.#onIndirectTimeout(targetId);
      return;
    }

    const indirectSeq = ++this.#seqCounter;
    for (const relayId of relays) {
      this.#sendFn(relayId, {
        type: SWIM_PING_REQ,
        from: this.#localId,
        target: targetId,
        seq: indirectSeq,
      });
    }

    // Start indirect timeout — if no SWIM_PING_ACK arrives, mark suspect
    const timer = setTimeout(() => {
      this.#pendingPings.delete(indirectSeq);
      this.#onIndirectTimeout(targetId);
    }, this.#pingTimeoutMs);

    this.#pendingPings.set(indirectSeq, { targetId, timer });
  }

  /**
   * Called when indirect pings also fail.  Mark the target as suspect
   * and start a suspect timer.
   *
   * @param {string} targetId
   */
  #onIndirectTimeout(targetId) {
    const entry = this.#members.get(targetId);
    if (!entry || entry.state !== 'alive') return;

    entry.state = 'suspect';
    entry.suspectAt = this.#nowFn();
    this.#enqueueUpdate({ podId: targetId, state: 'suspect', incarnation: entry.incarnation });
    if (this.onSuspect) this.onSuspect(targetId);

    // Start suspect timer
    const timer = setTimeout(() => this.#onSuspectTimeout(targetId), this.#suspectTimeoutMs);
    // Store with a unique seq so it can be cleared on stop()
    const seq = ++this.#seqCounter;
    this.#pendingPings.set(seq, { targetId, timer });
  }

  /**
   * Called when the suspect timer expires.  If the member is still
   * suspect, declare it dead.
   *
   * @param {string} podId
   */
  #onSuspectTimeout(podId) {
    const entry = this.#members.get(podId);
    if (!entry || entry.state !== 'suspect') return;

    entry.state = 'dead';
    entry.suspectAt = null;
    this.#enqueueUpdate({ podId, state: 'dead', incarnation: entry.incarnation });
    if (this.onDead) this.onDead(podId);
  }

  // -------------------------------------------------------------------------
  // Private — update dissemination
  // -------------------------------------------------------------------------

  /**
   * Apply a SWIM membership update using the standard rules:
   *  - Higher incarnation always wins
   *  - Same incarnation: dead > suspect > alive
   *  - Self-suspicion: bump local incarnation, broadcast alive
   *
   * @param {{podId: string, state: string, incarnation: number}} update
   */
  #processUpdate(update) {
    const { podId, state, incarnation } = update;

    // Self-suspicion refutation
    if (podId === this.#localId) {
      if (state === 'suspect' || state === 'dead') {
        this.#localIncarnation = Math.max(this.#localIncarnation, incarnation) + 1;
        this.#enqueueUpdate({ podId: this.#localId, state: 'alive', incarnation: this.#localIncarnation });
      }
      return;
    }

    const entry = this.#members.get(podId);
    if (!entry) {
      // Unknown member — add if alive or suspect
      if (state === 'alive' || state === 'suspect') {
        this.#members.set(podId, { state, incarnation, suspectAt: state === 'suspect' ? this.#nowFn() : null });
        if (state === 'alive' && this.onJoin) this.onJoin(podId);
        if (state === 'suspect' && this.onSuspect) this.onSuspect(podId);
      }
      return;
    }

    // Higher incarnation always wins
    if (incarnation > entry.incarnation) {
      const oldState = entry.state;
      entry.incarnation = incarnation;
      entry.state = state;
      entry.suspectAt = state === 'suspect' ? this.#nowFn() : null;
      this.#fireStateCallbacks(podId, oldState, state);
      return;
    }

    // Same incarnation — apply state priority: dead > suspect > alive
    if (incarnation === entry.incarnation) {
      const priority = { alive: 0, suspect: 1, dead: 2, left: 3 };
      if ((priority[state] ?? -1) > (priority[entry.state] ?? -1)) {
        const oldState = entry.state;
        entry.state = state;
        entry.suspectAt = state === 'suspect' ? this.#nowFn() : null;
        this.#fireStateCallbacks(podId, oldState, state);
      }
    }
    // Lower incarnation — ignore
  }

  /**
   * Fire the appropriate callback when a member's state changes.
   *
   * @param {string} podId
   * @param {string} oldState
   * @param {string} newState
   */
  #fireStateCallbacks(podId, oldState, newState) {
    if (oldState === newState) return;
    if (newState === 'alive' && this.onJoin) this.onJoin(podId);
    if (newState === 'suspect' && this.onSuspect) this.onSuspect(podId);
    if (newState === 'dead' && this.onDead) this.onDead(podId);
    if (newState === 'left' && this.onLeave) this.onLeave(podId);
  }

  /**
   * Enqueue a membership update for piggybacking on future messages.
   * The buffer is capped at 10 entries; duplicates for the same podId
   * are replaced, keeping the newest update.
   *
   * @param {{podId: string, state: string, incarnation: number}} update
   */
  #enqueueUpdate(update) {
    // Deduplicate by podId — keep newest
    const idx = this.#updateBuffer.findIndex(u => u.podId === update.podId);
    if (idx !== -1) {
      this.#updateBuffer[idx] = update;
    } else {
      this.#updateBuffer.push(update);
    }
    // Cap at 10
    if (this.#updateBuffer.length > 10) {
      this.#updateBuffer.shift();
    }
  }

  /**
   * Return and clear the current update buffer.
   *
   * @returns {Array<{podId: string, state: string, incarnation: number}>}
   */
  #drainUpdates() {
    const updates = [...this.#updateBuffer];
    this.#updateBuffer = [];
    return updates;
  }

  /**
   * Shuffle alive members (excluding self) into the ping queue.
   */
  #refillPingQueue() {
    const alive = this.aliveMembers().filter(id => id !== this.#localId);
    this.#pingQueue = this.#pickRandom(alive, alive.length);
  }

  /**
   * Fisher-Yates shuffle of `arr`, returning the first `count` elements.
   *
   * @param {string[]} arr
   * @param {number} count
   * @returns {string[]}
   */
  #pickRandom(arr, count) {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, count);
  }
}

export { TASK_STATUSES };
