/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-peer-agent-swarm.js — Multi-agent coordination protocol.
 *
 * Agents share goals, decompose tasks, divide work, merge results,
 * and achieve collective objectives across the mesh.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-agent-swarm.test.mjs
 */

// ---------------------------------------------------------------------------
// UUID polyfill
// ---------------------------------------------------------------------------

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => 'swarm-' + Math.random().toString(36).slice(2)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SWARM_STRATEGIES = Object.freeze({
  LEADER_DECOMPOSE: 'leader_decompose',
  COLLECTIVE_VOTE: 'collective_vote',
  ROUND_ROBIN: 'round_robin',
  CAPABILITY_MATCH: 'capability_match',
})

export const SWARM_DEFAULTS = Object.freeze({
  maxAgents: 10,
  strategy: 'round_robin',
  timeoutMs: 60000,
})

// ---------------------------------------------------------------------------
// SubTask
// ---------------------------------------------------------------------------

/**
 * Represents a single unit of work within a swarm's goal.
 */
export class SubTask {
  /** @type {string} */
  id

  /** @type {string} */
  description

  /** @type {string|null} */
  assignee

  /** @type {string[]} subtask ids that must complete first */
  dependencies

  /** @type {'pending'|'assigned'|'running'|'completed'|'failed'} */
  status

  /** @type {string|null} result of execution */
  result = null

  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.description
   * @param {string} [opts.assignee]
   * @param {string[]} [opts.dependencies]
   * @param {'pending'|'assigned'|'running'|'completed'|'failed'} [opts.status]
   */
  constructor({ id, description, assignee, dependencies, status }) {
    this.id = id
    this.description = description
    this.assignee = assignee ?? null
    this.dependencies = dependencies ?? []
    this.status = status ?? 'pending'
  }

  toJSON() {
    return {
      id: this.id,
      description: this.description,
      assignee: this.assignee,
      dependencies: [...this.dependencies],
      status: this.status,
      result: this.result,
    }
  }

  static fromJSON(json) {
    const st = new SubTask({
      id: json.id,
      description: json.description,
      assignee: json.assignee,
      dependencies: json.dependencies,
      status: json.status,
    })
    st.result = json.result ?? null
    return st
  }
}

// ---------------------------------------------------------------------------
// SwarmInstance
// ---------------------------------------------------------------------------

/**
 * Represents a swarm — a group of agents working toward a shared goal.
 */
export class SwarmInstance {
  /** @type {string} */
  id

  /** @type {string} */
  goal

  /** @type {string} */
  leader

  /** @type {string[]} podIds */
  members

  /** @type {string} */
  strategy

  /** @type {'forming'|'active'|'executing'|'merging'|'completed'|'failed'|'disbanded'} */
  status

  /** @type {SubTask[]} */
  subtasks = []

  /** @type {number} */
  timeoutMs

  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.goal
   * @param {string} opts.leader
   * @param {string[]} [opts.members]
   * @param {string} [opts.strategy]
   * @param {string} [opts.status]
   * @param {number} [opts.timeoutMs]
   */
  constructor({ id, goal, leader, members, strategy, status, timeoutMs }) {
    this.id = id ?? crypto.randomUUID()
    this.goal = goal
    this.leader = leader
    this.members = members ? [...members] : []
    this.strategy = strategy ?? SWARM_STRATEGIES.ROUND_ROBIN
    this.status = status ?? 'forming'
    this.timeoutMs = timeoutMs ?? SWARM_DEFAULTS.timeoutMs
  }

  /**
   * Add a member pod to this swarm.
   * @param {string} podId
   */
  addMember(podId) {
    if (!this.members.includes(podId)) {
      this.members.push(podId)
    }
  }

  /**
   * Remove a member pod from this swarm.
   * @param {string} podId
   */
  removeMember(podId) {
    this.members = this.members.filter(m => m !== podId)
  }

  /**
   * Set the list of subtasks for this swarm.
   * @param {SubTask[]} subtasks
   */
  setSubTasks(subtasks) {
    this.subtasks = subtasks
  }

  /**
   * Get a subtask by id.
   * @param {string} id
   * @returns {SubTask|null}
   */
  getSubTask(id) {
    return this.subtasks.find(st => st.id === id) ?? null
  }

  /**
   * Update a subtask's status and/or assignee.
   * @param {string} id
   * @param {object} updates
   * @param {string} [updates.status]
   * @param {string} [updates.assignee]
   */
  updateSubTask(id, updates) {
    const st = this.getSubTask(id)
    if (!st) return
    if (updates.status !== undefined) st.status = updates.status
    if (updates.assignee !== undefined) st.assignee = updates.assignee
    if (updates.result !== undefined) st.result = updates.result
  }

  /**
   * Get progress statistics for this swarm.
   * @returns {{ total: number, completed: number, failed: number, pct: number }}
   */
  getProgress() {
    const total = this.subtasks.length
    if (total === 0) return { total: 0, completed: 0, failed: 0, pct: 0 }
    const completed = this.subtasks.filter(st => st.status === 'completed').length
    const failed = this.subtasks.filter(st => st.status === 'failed').length
    const pct = Math.round((completed / total) * 100)
    return { total, completed, failed, pct }
  }

  toJSON() {
    return {
      id: this.id,
      goal: this.goal,
      leader: this.leader,
      members: [...this.members],
      strategy: this.strategy,
      status: this.status,
      timeoutMs: this.timeoutMs,
      subtasks: this.subtasks.map(st => st.toJSON()),
    }
  }

  static fromJSON(json) {
    const sw = new SwarmInstance({
      id: json.id,
      goal: json.goal,
      leader: json.leader,
      members: json.members,
      strategy: json.strategy,
      status: json.status,
      timeoutMs: json.timeoutMs,
    })
    sw.subtasks = (json.subtasks || []).map(st => SubTask.fromJSON(st))
    return sw
  }
}

// ---------------------------------------------------------------------------
// AgentSwarmCoordinator
// ---------------------------------------------------------------------------

/**
 * Coordinates multi-agent swarms — creation, task decomposition, assignment,
 * execution, and result collection.
 */
export class AgentSwarmCoordinator {
  /** @type {object} { async chat(podId, message) => string } */
  #agentProxy

  /** @type {Function} */
  #onLog

  /** @type {Map<string, SwarmInstance>} */
  #swarms = new Map()

  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map()

  /**
   * @param {object} opts
   * @param {object} opts.agentProxy - { async chat(podId, message) => string }
   * @param {Function} [opts.onLog] - (level, msg) => void
   */
  constructor({ agentProxy, onLog }) {
    if (!agentProxy) throw new Error('agentProxy is required')
    this.#agentProxy = agentProxy
    this.#onLog = onLog || (() => {})
  }

  // -- Swarm lifecycle -------------------------------------------------------

  /**
   * Create a new swarm with a shared goal.
   *
   * @param {string} goal
   * @param {object} [opts]
   * @param {string[]} [opts.members]
   * @param {number} [opts.maxAgents]
   * @param {string} [opts.strategy]
   * @param {number} [opts.timeoutMs]
   * @param {Function} [opts.decomposer] - async (goal) => string[]
   * @returns {Promise<SwarmInstance>}
   */
  async createSwarm(goal, opts = {}) {
    const members = (opts.members || []).slice(0, opts.maxAgents ?? SWARM_DEFAULTS.maxAgents)
    const leader = members[0] || 'local'
    const strategy = opts.strategy ?? SWARM_DEFAULTS.strategy
    const timeoutMs = opts.timeoutMs ?? SWARM_DEFAULTS.timeoutMs

    const swarm = new SwarmInstance({
      id: crypto.randomUUID(),
      goal,
      leader,
      members,
      strategy,
      status: 'active',
      timeoutMs,
    })

    this.#swarms.set(swarm.id, swarm)
    this.#log('info', `Swarm ${swarm.id} created for goal: ${goal}`)
    this.#emit('created', { swarmId: swarm.id, goal, leader })

    // Auto-decompose if a decomposer is provided
    if (opts.decomposer) {
      await this.decompose(swarm.id, opts.decomposer)
    }

    return swarm
  }

  /**
   * Decompose a swarm's goal into subtasks.
   *
   * @param {string} swarmId
   * @param {Function} [decomposer] - async (goal) => string[]
   * @returns {Promise<SubTask[]>}
   */
  async decompose(swarmId, decomposer) {
    const swarm = this.#swarms.get(swarmId)
    if (!swarm) throw new Error(`Swarm ${swarmId} not found`)

    let descriptions
    if (typeof decomposer === 'function') {
      descriptions = await decomposer(swarm.goal)
    } else {
      // Default: single subtask with the full goal
      descriptions = [swarm.goal]
    }

    const subtasks = descriptions.map((desc, i) =>
      new SubTask({
        id: `${swarmId}-st-${i}`,
        description: desc,
      })
    )

    swarm.setSubTasks(subtasks)
    this.#log('info', `Decomposed swarm ${swarmId} into ${subtasks.length} subtasks`)
    return subtasks
  }

  /**
   * Assign subtasks to swarm members based on the swarm's strategy.
   *
   * @param {string} swarmId
   * @returns {Promise<Array<{ subtaskId: string, assignee: string }>>}
   */
  async assign(swarmId) {
    const swarm = this.#swarms.get(swarmId)
    if (!swarm) throw new Error(`Swarm ${swarmId} not found`)

    const assignments = []
    const { subtasks, members, leader, strategy } = swarm

    if (members.length === 0) {
      this.#log('warn', `Swarm ${swarmId} has no members to assign tasks to`)
      return assignments
    }

    for (let i = 0; i < subtasks.length; i++) {
      const st = subtasks[i]
      let assignee

      switch (strategy) {
        case SWARM_STRATEGIES.LEADER_DECOMPOSE:
          assignee = leader
          break

        case SWARM_STRATEGIES.CAPABILITY_MATCH:
          // Simple keyword matching: pick member whose podId partially matches description
          assignee = members.find(m =>
            st.description.toLowerCase().includes(m.toLowerCase())
          ) || members[i % members.length]
          break

        case SWARM_STRATEGIES.COLLECTIVE_VOTE:
          // Assign to first available member
          assignee = members[0]
          break

        case SWARM_STRATEGIES.ROUND_ROBIN:
        default:
          assignee = members[i % members.length]
          break
      }

      st.assignee = assignee
      st.status = 'assigned'
      assignments.push({ subtaskId: st.id, assignee })
      this.#emit('task-assigned', { swarmId, subtaskId: st.id, assignee })
    }

    swarm.status = 'executing'
    this.#log('info', `Assigned ${assignments.length} subtasks in swarm ${swarmId}`)
    return assignments
  }

  /**
   * Execute a single subtask by delegating to the assigned agent.
   *
   * @param {string} swarmId
   * @param {string} subtaskId
   * @param {string} assignee
   * @returns {Promise<{ result: string, success: boolean, error?: string }>}
   */
  async executeSubTask(swarmId, subtaskId, assignee) {
    const swarm = this.#swarms.get(swarmId)
    if (!swarm) throw new Error(`Swarm ${swarmId} not found`)

    const st = swarm.getSubTask(subtaskId)
    if (!st) throw new Error(`SubTask ${subtaskId} not found`)

    st.status = 'running'

    try {
      const result = await this.#withTimeout(
        this.#agentProxy.chat(assignee, st.description),
        swarm.timeoutMs
      )
      st.status = 'completed'
      st.result = result
      this.#log('info', `SubTask ${subtaskId} completed by ${assignee}`)
      this.#emit('subtask-complete', { swarmId, subtaskId, assignee, result })
      return { result, success: true }
    } catch (err) {
      st.status = 'failed'
      const errorMsg = err.message || String(err)
      this.#log('error', `SubTask ${subtaskId} failed: ${errorMsg}`)
      return { result: null, success: false, error: errorMsg }
    }
  }

  /**
   * Collect and merge results from all completed subtasks.
   *
   * @param {string} swarmId
   * @param {Function} [mergeFn] - (results: string[]) => string
   * @returns {Promise<{ merged: string, individual: Array<{ subtaskId: string, result: string }> }>}
   */
  async collectResults(swarmId, mergeFn) {
    const swarm = this.#swarms.get(swarmId)
    if (!swarm) throw new Error(`Swarm ${swarmId} not found`)

    const individual = swarm.subtasks
      .filter(st => st.status === 'completed' && st.result !== null)
      .map(st => ({ subtaskId: st.id, result: st.result }))

    const results = individual.map(r => r.result)
    const merged = typeof mergeFn === 'function'
      ? mergeFn(results)
      : results.join('\n\n')

    swarm.status = 'completed'
    this.#log('info', `Swarm ${swarmId} completed with ${individual.length} results`)
    this.#emit('completed', { swarmId, merged, individual })

    return { merged, individual }
  }

  // -- Queries ---------------------------------------------------------------

  /**
   * Get a swarm by id.
   * @param {string} id
   * @returns {SwarmInstance|null}
   */
  getSwarm(id) {
    return this.#swarms.get(id) ?? null
  }

  /**
   * List all swarms.
   * @returns {SwarmInstance[]}
   */
  listSwarms() {
    return [...this.#swarms.values()]
  }

  /**
   * Disband a swarm.
   * @param {string} swarmId
   */
  async disbandSwarm(swarmId) {
    const swarm = this.#swarms.get(swarmId)
    if (!swarm) throw new Error(`Swarm ${swarmId} not found`)
    swarm.status = 'disbanded'
    this.#log('info', `Swarm ${swarmId} disbanded`)
    this.#emit('disbanded', { swarmId })
  }

  // -- Events ----------------------------------------------------------------

  /**
   * Register a listener for a swarm event.
   *
   * Events: created, joined, left, task-assigned, subtask-complete, completed, failed
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
   * Remove a listener for a swarm event.
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const set = this.#listeners.get(event)
    if (set) set.delete(cb)
  }

  // -- Internal --------------------------------------------------------------

  /**
   * Emit an event to all registered listeners.
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

  /**
   * Log a message via the onLog callback.
   * @param {string} level
   * @param {string} msg
   */
  #log(level, msg) {
    this.#onLog(level, msg)
  }

  /**
   * Race a promise against a timeout.
   * @param {Promise} promise
   * @param {number} ms
   * @returns {Promise}
   */
  #withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout: subtask execution exceeded time limit')), ms)
      promise.then(
        (val) => { clearTimeout(timer); resolve(val) },
        (err) => { clearTimeout(timer); reject(err) },
      ).catch(() => {})
    })
  }
}
