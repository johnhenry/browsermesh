/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-scheduler.js -- Mesh-aware task scheduling for BrowserMesh.
 *
 * Distributes tasks across mesh peers using configurable scheduling policies
 * (best-fit, first-fit, round-robin, load-balanced). Includes a priority queue,
 * constraint matching, retry logic, and callback-based lifecycle hooks.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-scheduler.test.mjs
 */

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

/** Submit a task to the mesh scheduler */
export const SCHED_SUBMIT = 0xcc;
/** Query status of a scheduled task */
export const SCHED_STATUS = 0xcd;
/** Cancel a scheduled task */
export const SCHED_CANCEL = 0xce;
/** Result of a completed scheduled task */
export const SCHED_RESULT = 0xcf;

// ---------------------------------------------------------------------------
// Valid enumerations
// ---------------------------------------------------------------------------

const VALID_STATUSES = Object.freeze([
  'pending', 'queued', 'assigned', 'running', 'completed', 'failed', 'cancelled',
]);

const VALID_PRIORITIES = Object.freeze([
  'low', 'normal', 'high', 'critical',
]);

const PRIORITY_WEIGHT = Object.freeze({
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
});

const VALID_POLICIES = Object.freeze([
  'best-fit', 'first-fit', 'round-robin', 'load-balanced',
]);

// ---------------------------------------------------------------------------
// ScheduledTask
// ---------------------------------------------------------------------------

/**
 * A task to be scheduled across the mesh.
 */
export class ScheduledTask {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.type
   * @param {*} opts.payload
   * @param {'low'|'normal'|'high'|'critical'} [opts.priority='normal']
   * @param {object} [opts.constraints={}]
   * @param {string} opts.submittedBy
   * @param {number} [opts.submittedAt]
   * @param {number|null} [opts.deadline]
   * @param {number} [opts.retries=0]
   * @param {number} [opts.maxRetries=3]
   * @param {string} [opts.status='pending']
   */
  constructor({
    id,
    type,
    payload,
    priority = 'normal',
    constraints = {},
    submittedBy,
    submittedAt,
    deadline,
    retries = 0,
    maxRetries = 3,
    status = 'pending',
  }) {
    if (!id || typeof id !== 'string') {
      throw new Error('id is required and must be a non-empty string');
    }
    if (!type || typeof type !== 'string') {
      throw new Error('type is required and must be a non-empty string');
    }
    if (!submittedBy || typeof submittedBy !== 'string') {
      throw new Error('submittedBy is required and must be a non-empty string');
    }
    if (!VALID_PRIORITIES.includes(priority)) {
      throw new Error(`Invalid priority: "${priority}". Must be one of: ${VALID_PRIORITIES.join(', ')}`);
    }
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid status: "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    this.id = id;
    this.type = type;
    this.payload = payload !== undefined ? payload : null;
    this.priority = priority;
    this.constraints = constraints ? { ...constraints } : {};
    this.submittedBy = submittedBy;
    this.submittedAt = submittedAt ?? Date.now();
    this.deadline = deadline ?? null;
    this.retries = retries;
    this.maxRetries = maxRetries;
    this.status = status;
    // Internal fields set during lifecycle
    this.assignedTo = null;
    this.result = null;
    this.error = null;
    this.assignedAt = null;
    this.completedAt = null;
  }

  /**
   * Whether the task has passed its deadline.
   * @param {number} [now]
   * @returns {boolean}
   */
  isExpired(now = Date.now()) {
    if (this.deadline === null || this.deadline === undefined) return false;
    return now > this.deadline;
  }

  /**
   * Whether the task may be retried.
   * @returns {boolean}
   */
  canRetry() {
    return this.retries < this.maxRetries;
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      payload: this.payload != null && typeof this.payload === 'object'
        ? JSON.parse(JSON.stringify(this.payload))
        : this.payload,
      priority: this.priority,
      constraints: { ...this.constraints },
      submittedBy: this.submittedBy,
      submittedAt: this.submittedAt,
      deadline: this.deadline,
      retries: this.retries,
      maxRetries: this.maxRetries,
      status: this.status,
      assignedTo: this.assignedTo,
      result: this.result,
      error: this.error,
      assignedAt: this.assignedAt,
      completedAt: this.completedAt,
    };
  }

  /**
   * @param {object} data
   * @returns {ScheduledTask}
   */
  static fromJSON(data) {
    const task = new ScheduledTask({
      id: data.id,
      type: data.type,
      payload: data.payload,
      priority: data.priority,
      constraints: data.constraints,
      submittedBy: data.submittedBy,
      submittedAt: data.submittedAt,
      deadline: data.deadline,
      retries: data.retries,
      maxRetries: data.maxRetries,
      status: data.status,
    });
    task.assignedTo = data.assignedTo ?? null;
    task.result = data.result ?? null;
    task.error = data.error ?? null;
    task.assignedAt = data.assignedAt ?? null;
    task.completedAt = data.completedAt ?? null;
    return task;
  }
}

// ---------------------------------------------------------------------------
// TaskConstraints
// ---------------------------------------------------------------------------

/**
 * Scheduling constraints for a task.
 */
export class TaskConstraints {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.requiredCaps=[]]
   * @param {number} [opts.minMemoryMb=0]
   * @param {number} [opts.minCpuCores=0]
   * @param {boolean} [opts.preferLocal=false]
   * @param {number|null} [opts.maxLatencyMs=null]
   * @param {string[]} [opts.affinityPodIds=[]]
   * @param {string[]} [opts.antiAffinityPodIds=[]]
   */
  constructor(opts = {}) {
    this.requiredCaps = opts.requiredCaps ? [...opts.requiredCaps] : [];
    this.minMemoryMb = opts.minMemoryMb ?? 0;
    this.minCpuCores = opts.minCpuCores ?? 0;
    this.preferLocal = opts.preferLocal ?? false;
    this.maxLatencyMs = opts.maxLatencyMs ?? null;
    this.affinityPodIds = opts.affinityPodIds ? [...opts.affinityPodIds] : [];
    this.antiAffinityPodIds = opts.antiAffinityPodIds ? [...opts.antiAffinityPodIds] : [];
  }

  /**
   * Check whether a resource descriptor satisfies these constraints.
   *
   * @param {object} resourceDescriptor
   * @param {string[]} [resourceDescriptor.capabilities]
   * @param {object} [resourceDescriptor.resources]
   * @param {number} [resourceDescriptor.resources.memory]
   * @param {number} [resourceDescriptor.resources.cpu]
   * @param {string} [resourceDescriptor.podId]
   * @returns {boolean}
   */
  matches(resourceDescriptor) {
    if (!resourceDescriptor) return false;

    // Required capabilities
    if (this.requiredCaps.length > 0) {
      const caps = resourceDescriptor.capabilities || [];
      for (const cap of this.requiredCaps) {
        if (!caps.includes(cap)) return false;
      }
    }

    // Minimum memory
    const mem = resourceDescriptor.resources?.memory ?? 0;
    if (this.minMemoryMb > 0 && mem < this.minMemoryMb) return false;

    // Minimum CPU cores
    const cpu = resourceDescriptor.resources?.cpu ?? 0;
    if (this.minCpuCores > 0 && cpu < this.minCpuCores) return false;

    // Affinity: must be one of the listed pods (if any listed)
    if (this.affinityPodIds.length > 0) {
      if (!resourceDescriptor.podId || !this.affinityPodIds.includes(resourceDescriptor.podId)) {
        return false;
      }
    }

    // Anti-affinity: must NOT be any of the listed pods
    if (this.antiAffinityPodIds.length > 0) {
      if (resourceDescriptor.podId && this.antiAffinityPodIds.includes(resourceDescriptor.podId)) {
        return false;
      }
    }

    return true;
  }

  toJSON() {
    return {
      requiredCaps: [...this.requiredCaps],
      minMemoryMb: this.minMemoryMb,
      minCpuCores: this.minCpuCores,
      preferLocal: this.preferLocal,
      maxLatencyMs: this.maxLatencyMs,
      affinityPodIds: [...this.affinityPodIds],
      antiAffinityPodIds: [...this.antiAffinityPodIds],
    };
  }

  /**
   * @param {object} data
   * @returns {TaskConstraints}
   */
  static fromJSON(data) {
    return new TaskConstraints({
      requiredCaps: data.requiredCaps,
      minMemoryMb: data.minMemoryMb,
      minCpuCores: data.minCpuCores,
      preferLocal: data.preferLocal,
      maxLatencyMs: data.maxLatencyMs,
      affinityPodIds: data.affinityPodIds,
      antiAffinityPodIds: data.antiAffinityPodIds,
    });
  }
}

// ---------------------------------------------------------------------------
// TaskQueue
// ---------------------------------------------------------------------------

/**
 * Priority queue for scheduled tasks.
 *
 * Default ordering: higher priority first, then earlier deadline,
 * then earlier submittedAt.
 */
export class TaskQueue {
  /** @type {ScheduledTask[]} */
  #items = [];
  #comparator;

  /**
   * @param {object} [opts]
   * @param {function} [opts.comparator] - (a, b) => number. Negative = a first.
   */
  constructor(opts = {}) {
    this.#comparator = opts.comparator ?? _defaultComparator;
  }

  /**
   * Add a task to the queue.
   * @param {ScheduledTask} task
   */
  enqueue(task) {
    this.#items.push(task);
    this.#items.sort(this.#comparator);
  }

  /**
   * Remove and return the highest-priority task.
   * @returns {ScheduledTask|null}
   */
  dequeue() {
    if (this.#items.length === 0) return null;
    return this.#items.shift();
  }

  /**
   * View the highest-priority task without removing.
   * @returns {ScheduledTask|null}
   */
  peek() {
    if (this.#items.length === 0) return null;
    return this.#items[0];
  }

  /**
   * Remove a task by ID.
   * @param {string} taskId
   * @returns {boolean}
   */
  remove(taskId) {
    const idx = this.#items.findIndex(t => t.id === taskId);
    if (idx === -1) return false;
    this.#items.splice(idx, 1);
    return true;
  }

  /** @returns {number} */
  get size() {
    return this.#items.length;
  }

  /** @returns {boolean} */
  get isEmpty() {
    return this.#items.length === 0;
  }

  /**
   * Return a sorted copy of the queue contents.
   * @returns {ScheduledTask[]}
   */
  toArray() {
    return [...this.#items];
  }
}

/**
 * Default comparator: higher priority weight first, then earlier deadline,
 * then earlier submittedAt.
 */
function _defaultComparator(a, b) {
  const wa = PRIORITY_WEIGHT[a.priority] ?? 0;
  const wb = PRIORITY_WEIGHT[b.priority] ?? 0;
  if (wa !== wb) return wb - wa;

  // Earlier deadline first; null deadlines sort to the end
  const da = a.deadline ?? Infinity;
  const db = b.deadline ?? Infinity;
  if (da !== db) return da - db;

  return (a.submittedAt ?? 0) - (b.submittedAt ?? 0);
}

// ---------------------------------------------------------------------------
// MeshScheduler
// ---------------------------------------------------------------------------

/**
 * Distributes tasks across mesh peers with configurable scheduling policies.
 */
export class MeshScheduler {
  /** @type {string} */
  #localPodId;
  /** @type {Map<string, ScheduledTask>} */
  #tasks = new Map();
  /** @type {TaskQueue} */
  #queue = new TaskQueue();
  /** @type {Map<string, object>} podId -> resource descriptor */
  #nodes = new Map();
  /** @type {number} */
  #maxConcurrent;
  /** @type {string} */
  #schedulingPolicy;
  /** @type {number} round-robin index */
  #rrIndex = 0;

  // Stats
  #totalSubmitted = 0;
  #completed = 0;
  #failed = 0;
  #totalWaitMs = 0;
  #totalRunMs = 0;

  // Callbacks
  #onAssigned = [];
  #onCompleted = [];
  #onFailed = [];

  /**
   * @param {object} opts
   * @param {string} opts.localPodId
   * @param {number} [opts.maxConcurrent=10]
   * @param {'best-fit'|'first-fit'|'round-robin'|'load-balanced'} [opts.schedulingPolicy='best-fit']
   */
  constructor({ localPodId, maxConcurrent = 10, schedulingPolicy = 'best-fit' } = {}) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string');
    }
    if (!VALID_POLICIES.includes(schedulingPolicy)) {
      throw new Error(`Invalid scheduling policy: "${schedulingPolicy}". Must be one of: ${VALID_POLICIES.join(', ')}`);
    }

    this.#localPodId = localPodId;
    this.#maxConcurrent = maxConcurrent;
    this.#schedulingPolicy = schedulingPolicy;
  }

  /** @returns {number} */
  get maxConcurrent() {
    return this.#maxConcurrent;
  }

  /** @returns {string} */
  get schedulingPolicy() {
    return this.#schedulingPolicy;
  }

  // -- Task lifecycle -------------------------------------------------------

  /**
   * Submit a task to the scheduler.
   * @param {ScheduledTask} task
   * @returns {Promise<string>} task ID
   */
  async submit(task) {
    if (this.#tasks.has(task.id)) {
      throw new Error(`Task "${task.id}" already exists`);
    }
    task.status = 'queued';
    this.#tasks.set(task.id, task);
    this.#queue.enqueue(task);
    this.#totalSubmitted++;
    return task.id;
  }

  /**
   * Cancel a pending/queued/assigned/running task.
   * @param {string} taskId
   * @returns {Promise<boolean>}
   */
  async cancel(taskId) {
    const task = this.#tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return false;
    }
    task.status = 'cancelled';
    task.completedAt = Date.now();
    this.#queue.remove(taskId);
    return true;
  }

  /**
   * Assign a task to a specific pod.
   * @param {string} taskId
   * @param {string} podId
   */
  assign(taskId, podId) {
    const task = this.#tasks.get(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);
    task.status = 'assigned';
    task.assignedTo = podId;
    task.assignedAt = Date.now();
    this.#queue.remove(taskId);
    for (const cb of this.#onAssigned) cb(taskId, podId);
  }

  /**
   * Mark a task as completed with a result.
   * @param {string} taskId
   * @param {*} result
   */
  complete(taskId, result) {
    const task = this.#tasks.get(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);
    task.status = 'completed';
    task.result = result;
    task.completedAt = Date.now();
    this.#completed++;

    // Track timing
    if (task.assignedAt) {
      this.#totalRunMs += task.completedAt - task.assignedAt;
    }
    if (task.submittedAt && task.assignedAt) {
      this.#totalWaitMs += task.assignedAt - task.submittedAt;
    }

    this.#queue.remove(taskId);
    for (const cb of this.#onCompleted) cb(taskId, result);
  }

  /**
   * Mark a task as failed, possibly requeue for retry.
   * @param {string} taskId
   * @param {string} error
   */
  fail(taskId, error) {
    const task = this.#tasks.get(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);

    task.retries++;

    if (task.canRetry()) {
      // Requeue for retry
      task.status = 'queued';
      task.assignedTo = null;
      task.assignedAt = null;
      task.error = null;
      this.#queue.enqueue(task);
    } else {
      // Permanent failure
      task.status = 'failed';
      task.error = error;
      task.completedAt = Date.now();
      this.#failed++;
      for (const cb of this.#onFailed) cb(taskId, error);
    }
  }

  /**
   * Look up a task by ID.
   * @param {string} taskId
   * @returns {ScheduledTask|null}
   */
  getTask(taskId) {
    return this.#tasks.get(taskId) ?? null;
  }

  /**
   * List tasks, optionally filtered.
   * @param {object} [filter]
   * @param {string} [filter.status]
   * @param {string} [filter.type]
   * @param {string} [filter.submittedBy]
   * @returns {ScheduledTask[]}
   */
  listTasks(filter) {
    const results = [];
    for (const task of this.#tasks.values()) {
      if (filter) {
        if (filter.status && task.status !== filter.status) continue;
        if (filter.type && task.type !== filter.type) continue;
        if (filter.submittedBy && task.submittedBy !== filter.submittedBy) continue;
      }
      results.push(task);
    }
    return results;
  }

  /**
   * Count of tasks in queued status.
   * @returns {number}
   */
  getQueueDepth() {
    let count = 0;
    for (const task of this.#tasks.values()) {
      if (task.status === 'queued') count++;
    }
    return count;
  }

  /**
   * Count of tasks in assigned or running status.
   * @returns {number}
   */
  getRunningCount() {
    let count = 0;
    for (const task of this.#tasks.values()) {
      if (task.status === 'assigned' || task.status === 'running') count++;
    }
    return count;
  }

  // -- Node management ------------------------------------------------------

  /**
   * Register a node with its resource descriptor.
   * @param {string} podId
   * @param {object} resources
   */
  registerNode(podId, resources) {
    this.#nodes.set(podId, resources);
  }

  /**
   * Remove a registered node.
   * @param {string} podId
   * @returns {boolean}
   */
  unregisterNode(podId) {
    return this.#nodes.delete(podId);
  }

  // -- Scheduling cycle -----------------------------------------------------

  /**
   * Run one scheduling cycle: match queued tasks to available nodes.
   * @returns {Promise<number>} number of tasks assigned
   */
  async schedule() {
    if (this.#nodes.size === 0) return 0;

    let assigned = 0;
    const nodeIds = [...this.#nodes.keys()];

    // Collect queued tasks from the queue
    const queuedTasks = [];
    const queueSnapshot = this.#queue.toArray();
    for (const task of queueSnapshot) {
      if (task.status === 'queued') {
        queuedTasks.push(task);
      }
    }

    for (const task of queuedTasks) {
      // Check concurrent limit
      if (this.getRunningCount() >= this.#maxConcurrent) break;

      // Resolve constraints
      const constraints = task.constraints && task.constraints.requiredCaps
        ? TaskConstraints.fromJSON(task.constraints)
        : new TaskConstraints(task.constraints || {});

      // Find matching nodes
      const matchingNodes = [];
      for (const nodeId of nodeIds) {
        const nodeRes = this.#nodes.get(nodeId);
        if (constraints.matches(nodeRes)) {
          matchingNodes.push({ podId: nodeId, ...nodeRes });
        }
      }

      if (matchingNodes.length === 0) continue;

      let selectedPodId;

      switch (this.#schedulingPolicy) {
        case 'first-fit':
          selectedPodId = matchingNodes[0].podId;
          break;

        case 'round-robin':
          selectedPodId = matchingNodes[this.#rrIndex % matchingNodes.length].podId;
          this.#rrIndex++;
          break;

        case 'load-balanced': {
          let minLoad = Infinity;
          let minPod = matchingNodes[0].podId;
          for (const node of matchingNodes) {
            const load = node.load ?? 0;
            if (load < minLoad) {
              minLoad = load;
              minPod = node.podId;
            }
          }
          selectedPodId = minPod;
          break;
        }

        case 'best-fit':
        default: {
          // Score by how well resources match constraints
          let bestScore = -1;
          let bestPod = matchingNodes[0].podId;
          for (const node of matchingNodes) {
            let score = 0;
            const mem = node.resources?.memory ?? 0;
            const cpu = node.resources?.cpu ?? 0;
            if (constraints.minMemoryMb > 0 && mem > 0) {
              // Tighter fit = higher score (inverse of excess)
              score += Math.max(0, 100 - Math.abs(mem - constraints.minMemoryMb) / 10);
            } else {
              score += mem / 100;
            }
            if (constraints.minCpuCores > 0 && cpu > 0) {
              score += Math.max(0, 50 - Math.abs(cpu - constraints.minCpuCores) * 5);
            } else {
              score += cpu * 5;
            }
            if (score > bestScore) {
              bestScore = score;
              bestPod = node.podId;
            }
          }
          selectedPodId = bestPod;
          break;
        }
      }

      this.assign(task.id, selectedPodId);
      assigned++;
    }

    return assigned;
  }

  // -- Callbacks ------------------------------------------------------------

  /**
   * Register a callback for task assignment.
   * @param {function(string, string)} cb - (taskId, podId)
   */
  onTaskAssigned(cb) {
    this.#onAssigned.push(cb);
  }

  /**
   * Register a callback for task completion.
   * @param {function(string, *)} cb - (taskId, result)
   */
  onTaskCompleted(cb) {
    this.#onCompleted.push(cb);
  }

  /**
   * Register a callback for permanent task failure.
   * @param {function(string, string)} cb - (taskId, error)
   */
  onTaskFailed(cb) {
    this.#onFailed.push(cb);
  }

  // -- Stats ----------------------------------------------------------------

  /**
   * @returns {{ totalSubmitted: number, completed: number, failed: number, avgWaitMs: number, avgRunMs: number }}
   */
  getStats() {
    const completedAndFailed = this.#completed + this.#failed;
    return {
      totalSubmitted: this.#totalSubmitted,
      completed: this.#completed,
      failed: this.#failed,
      avgWaitMs: completedAndFailed > 0 ? Math.round(this.#totalWaitMs / completedAndFailed) : 0,
      avgRunMs: this.#completed > 0 ? Math.round(this.#totalRunMs / this.#completed) : 0,
    };
  }

  // -- Serialization --------------------------------------------------------

  toJSON() {
    const tasks = [];
    for (const task of this.#tasks.values()) {
      tasks.push(task.toJSON());
    }
    const nodes = [];
    for (const [podId, res] of this.#nodes) {
      nodes.push({ podId, ...res });
    }
    return {
      localPodId: this.#localPodId,
      maxConcurrent: this.#maxConcurrent,
      schedulingPolicy: this.#schedulingPolicy,
      tasks,
      nodes,
      stats: {
        totalSubmitted: this.#totalSubmitted,
        completed: this.#completed,
        failed: this.#failed,
        totalWaitMs: this.#totalWaitMs,
        totalRunMs: this.#totalRunMs,
      },
    };
  }

  /**
   * @param {object} data
   * @returns {MeshScheduler}
   */
  static fromJSON(data) {
    const sched = new MeshScheduler({
      localPodId: data.localPodId,
      maxConcurrent: data.maxConcurrent,
      schedulingPolicy: data.schedulingPolicy,
    });

    // Restore stats
    if (data.stats) {
      sched.#totalSubmitted = data.stats.totalSubmitted ?? 0;
      sched.#completed = data.stats.completed ?? 0;
      sched.#failed = data.stats.failed ?? 0;
      sched.#totalWaitMs = data.stats.totalWaitMs ?? 0;
      sched.#totalRunMs = data.stats.totalRunMs ?? 0;
    }

    // Restore nodes
    if (data.nodes) {
      for (const node of data.nodes) {
        const { podId, ...rest } = node;
        sched.#nodes.set(podId, rest);
      }
    }

    // Restore tasks
    if (data.tasks) {
      for (const taskData of data.tasks) {
        const task = ScheduledTask.fromJSON(taskData);
        sched.#tasks.set(task.id, task);
        if (task.status === 'queued' || task.status === 'pending') {
          sched.#queue.enqueue(task);
        }
      }
    }

    return sched;
  }
}
