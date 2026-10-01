/**
 * clawser-mesh-resources.js -- Resource advertisement, discovery, and job
 * scheduling for BrowserMesh.
 *
 * Peers advertise hardware/software resources, discover matching nodes, score
 * candidates, and submit compute jobs through a lightweight queue.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-resources.test.mjs
 */

import { MESH_TYPE } from '@johnhenry/browsermesh-primitives';

// ---------------------------------------------------------------------------
// Wire constants — imported from canonical registry
// ---------------------------------------------------------------------------

/** Advertise local resources to the mesh */
export const RESOURCE_ADVERTISE = MESH_TYPE.RESOURCE_ADVERTISE;
/** Discover peers matching resource constraints */
export const RESOURCE_DISCOVER = MESH_TYPE.RESOURCE_DISCOVER;
/** Response to a discovery query */
export const RESOURCE_DISCOVER_RESPONSE = MESH_TYPE.RESOURCE_DISCOVER_RESPONSE;
/** Submit a compute request */
export const COMPUTE_REQUEST = MESH_TYPE.COMPUTE_REQUEST;
/** Return a compute result */
export const COMPUTE_RESULT = MESH_TYPE.COMPUTE_RESULT;
/** Incremental progress update for a running job */
export const COMPUTE_PROGRESS = MESH_TYPE.COMPUTE_PROGRESS;

// ---------------------------------------------------------------------------
// Runtime classes and isolation lanes (issue #185, WP4)
// ---------------------------------------------------------------------------

/**
 * Canonical runtime class values a `ResourceDescriptor` advertises as
 * `runtime:<class>` capabilities, and that `ComputeRequest.constraints`
 * reasons about. See the "Runtime classes and placement lanes" section of
 * this package's README and https://github.com/johnhenry/browsermesh/issues/185.
 */
export const RUNTIME_CLASS = Object.freeze({
  BROWSER: 'browser',
  NODE: 'node',
  ISOLATE: 'isolate',
  MICROVM: 'microvm',
});

/**
 * Isolation lane a `ComputeRequest` may require: `'any'` lets the scorer
 * prefer a lane, `'isolate'`/`'microvm'` hard-require it.
 */
export const ISOLATION = Object.freeze({
  ANY: 'any',
  ISOLATE: 'isolate',
  MICROVM: 'microvm',
});

const VALID_MODULE_TYPES = new Set(['wasm', 'js', 'shell']);
const VALID_ISOLATIONS = new Set(Object.values(ISOLATION));

// ---------------------------------------------------------------------------
// ResourceDescriptor
// ---------------------------------------------------------------------------

/**
 * Describes the resources a mesh pod makes available.
 */
export class ResourceDescriptor {
  /**
   * @param {object} opts
   * @param {string} opts.podId
   * @param {object} [opts.resources]
   * @param {number} [opts.resources.cpu]      - Logical cores (0 = unknown)
   * @param {number} [opts.resources.gpu]      - GPU count (0 = none)
   * @param {number} [opts.resources.memory]   - Available MB
   * @param {number} [opts.resources.storage]  - Available MB
   * @param {number} [opts.resources.bandwidth] - Mbps estimate
   * @param {string[]} [opts.capabilities]
   * @param {'online'|'busy'|'offline'} [opts.availability]
   * @param {number} [opts.updatedAt]
   * @param {number} [opts.ttl]  - Time-to-live in ms (default 60 000)
   * @param {string|null} [opts.hostedBy] - podId of the host pod, for pods
   *   placed on a lane host (issue #185 §7: "hosted pods are child-role
   *   pods of the host pod"). `null`/omitted for a self-hosted pod.
   */
  constructor({
    podId,
    resources = {},
    capabilities = [],
    availability = 'online',
    updatedAt,
    ttl,
    hostedBy,
  }) {
    if (!podId || typeof podId !== 'string') {
      throw new Error('podId is required and must be a non-empty string');
    }
    this.podId = podId;
    this.resources = {
      cpu: resources.cpu ?? 0,
      gpu: resources.gpu ?? 0,
      memory: resources.memory ?? 0,
      storage: resources.storage ?? 0,
      bandwidth: resources.bandwidth ?? 0,
    };
    this.capabilities = [...capabilities];
    this.availability = availability;
    this.updatedAt = updatedAt ?? Date.now();
    this.ttl = ttl ?? 60_000;
    this.hostedBy = hostedBy || null;
  }

  /**
   * Check whether this descriptor satisfies the given constraints.
   *
   * Constraints may include any subset of resource fields (minimum values),
   * a required `capabilities` array, and an `availability` value.
   *
   * @param {object} [constraints]
   * @returns {boolean}
   */
  matches(constraints) {
    if (!constraints) return true;

    // Availability check
    if (constraints.availability && this.availability !== constraints.availability) {
      return false;
    }

    // Resource minimums
    for (const key of ['cpu', 'gpu', 'memory', 'storage', 'bandwidth']) {
      if (constraints[key] !== undefined && this.resources[key] < constraints[key]) {
        return false;
      }
    }

    // Required capabilities
    if (constraints.capabilities) {
      for (const cap of constraints.capabilities) {
        if (!this.capabilities.includes(cap)) return false;
      }
    }

    return true;
  }

  /**
   * @param {number} [now]
   * @returns {boolean}
   */
  isExpired(now = Date.now()) {
    return now > this.updatedAt + this.ttl;
  }

  toJSON() {
    const json = {
      podId: this.podId,
      resources: { ...this.resources },
      capabilities: [...this.capabilities],
      availability: this.availability,
      updatedAt: this.updatedAt,
      ttl: this.ttl,
    };
    if (this.hostedBy) json.hostedBy = this.hostedBy;
    return json;
  }

  /**
   * @param {object} data
   * @returns {ResourceDescriptor}
   */
  static fromJSON(data) {
    return new ResourceDescriptor({
      podId: data.podId,
      resources: data.resources,
      capabilities: data.capabilities,
      availability: data.availability,
      updatedAt: data.updatedAt,
      ttl: data.ttl,
      hostedBy: data.hostedBy,
    });
  }
}

// ---------------------------------------------------------------------------
// ResourceRegistry
// ---------------------------------------------------------------------------

/**
 * Local registry of known resource descriptors, keyed by podId.
 */
export class ResourceRegistry {
  /** @type {Map<string, ResourceDescriptor>} */
  #entries = new Map();
  #maxEntries;
  #ttlMs;

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntries=1024]
   * @param {number} [opts.ttlMs=60000] - Default TTL applied when advertising
   */
  constructor(opts = {}) {
    this.#maxEntries = opts.maxEntries ?? 1024;
    this.#ttlMs = opts.ttlMs ?? 60_000;
  }

  /**
   * Advertise (upsert) a descriptor. Applies the registry-level TTL if the
   * descriptor does not already have one.
   *
   * @param {ResourceDescriptor} descriptor
   */
  advertise(descriptor) {
    if (this.#entries.size >= this.#maxEntries && !this.#entries.has(descriptor.podId)) {
      throw new Error('ResourceRegistry is full');
    }
    descriptor.updatedAt = Date.now();
    if (!descriptor.ttl) descriptor.ttl = this.#ttlMs;
    this.#entries.set(descriptor.podId, descriptor);
  }

  /**
   * Withdraw a pod's advertisement.
   *
   * @param {string} podId
   * @returns {boolean}
   */
  withdraw(podId) {
    return this.#entries.delete(podId);
  }

  /**
   * @param {string} podId
   * @returns {ResourceDescriptor|null}
   */
  get(podId) {
    return this.#entries.get(podId) ?? null;
  }

  /**
   * Discover descriptors matching optional constraints. Only returns
   * non-expired entries.
   *
   * @param {object} [constraints]
   * @returns {ResourceDescriptor[]}
   */
  discover(constraints) {
    const now = Date.now();
    const results = [];
    for (const desc of this.#entries.values()) {
      if (desc.isExpired(now)) continue;
      if (desc.matches(constraints)) results.push(desc);
    }
    return results;
  }

  /**
   * Remove all expired entries.
   * @returns {number} count of entries removed
   */
  pruneExpired() {
    const now = Date.now();
    let count = 0;
    for (const [podId, desc] of this.#entries) {
      if (desc.isExpired(now)) {
        this.#entries.delete(podId);
        count++;
      }
    }
    return count;
  }

  /** @returns {number} */
  get size() {
    return this.#entries.size;
  }

  /**
   * List all entries (including expired).
   * @returns {ResourceDescriptor[]}
   */
  listAll() {
    return [...this.#entries.values()];
  }

  toJSON() {
    return [...this.#entries.values()].map(d => d.toJSON());
  }

  /**
   * @param {object[]} data
   * @returns {ResourceRegistry}
   */
  static fromJSON(data) {
    const reg = new ResourceRegistry();
    for (const item of data) {
      const desc = ResourceDescriptor.fromJSON(item);
      reg.#entries.set(desc.podId, desc);
    }
    return reg;
  }
}

// ---------------------------------------------------------------------------
// ComputeRequest
// ---------------------------------------------------------------------------

/**
 * A request to execute a compute job on a remote mesh node.
 */
export class ComputeRequest {
  /**
   * @param {object} opts
   * @param {string} [opts.jobId]
   * @param {'wasm'|'js'|'shell'} opts.moduleType
   * @param {string} opts.moduleCid - Content-addressed ID of the module
   * @param {string} opts.entry     - Entry function name
   * @param {*} [opts.input]        - Serializable input payload
   * @param {object} [opts.constraints]
   * @param {string} [opts.constraints.prefer] - 'gpu'|'cpu'|'any'
   * @param {string} [opts.constraints.preferRuntimeClass]
   * @param {'any'|'isolate'|'microvm'} [opts.constraints.isolation] - Required
   *   placement lane (issue #185 §6). Default `'any'`.
   * @param {string[]} [opts.constraints.capabilities]
   * @param {number} [opts.constraints.timeoutMs]
   * @param {number} [opts.constraints.maxMemoryMb]
   * @param {number} [opts.constraints.priority] - 0 = low, higher = more urgent
   * @param {string} opts.requesterId
   * @param {number} [opts.timestamp]
   */
  constructor({
    jobId,
    moduleType,
    moduleCid,
    entry,
    input,
    constraints = {},
    requesterId,
    timestamp,
  }) {
    if (moduleType != null && !VALID_MODULE_TYPES.has(moduleType)) {
      throw new Error(`moduleType must be one of 'wasm', 'js', 'shell' (got "${moduleType}")`);
    }
    const isolation = constraints.isolation ?? ISOLATION.ANY;
    if (!VALID_ISOLATIONS.has(isolation)) {
      throw new Error(`constraints.isolation must be one of 'any', 'isolate', 'microvm' (got "${isolation}")`);
    }

    this.jobId = jobId ?? _genId();
    this.moduleType = moduleType;
    this.moduleCid = moduleCid;
    this.entry = entry;
    this.input = input ?? null;
    this.constraints = {
      ...constraints,
      prefer: constraints.prefer ?? 'any',
      preferRuntimeClass: constraints.preferRuntimeClass ?? null,
      isolation,
      capabilities: [...(constraints.capabilities || [])],
      timeoutMs: constraints.timeoutMs ?? 30_000,
      maxMemoryMb: constraints.maxMemoryMb ?? null,
      priority: constraints.priority ?? 0,
    };
    this.requesterId = requesterId;
    this.timestamp = timestamp ?? Date.now();
  }

  toJSON() {
    return {
      jobId: this.jobId,
      moduleType: this.moduleType,
      moduleCid: this.moduleCid,
      entry: this.entry,
      input: this.input,
      constraints: { ...this.constraints },
      requesterId: this.requesterId,
      timestamp: this.timestamp,
    };
  }

  /**
   * @param {object} data
   * @returns {ComputeRequest}
   */
  static fromJSON(data) {
    return new ComputeRequest({
      jobId: data.jobId,
      moduleType: data.moduleType,
      moduleCid: data.moduleCid,
      entry: data.entry,
      input: data.input,
      constraints: data.constraints,
      requesterId: data.requesterId,
      timestamp: data.timestamp,
    });
  }
}

// ---------------------------------------------------------------------------
// ComputeResult
// ---------------------------------------------------------------------------

/**
 * The result of a completed (or failed) compute job.
 */
export class ComputeResult {
  /**
   * @param {object} opts
   * @param {string} opts.jobId
   * @param {'success'|'error'|'cancelled'|'timeout'} opts.status
   * @param {*} [opts.result]
   * @param {string} [opts.error]
   * @param {object} [opts.metrics]
   * @param {string} [opts.metrics.executorId]
   * @param {number} [opts.metrics.startTime]
   * @param {number} [opts.metrics.endTime]
   * @param {number} [opts.metrics.cpuTimeMs]
   * @param {number} [opts.metrics.memoryPeakMb]
   */
  constructor({ jobId, status, result, error, metrics = {} }) {
    this.jobId = jobId;
    this.status = status;
    this.result = result ?? null;
    this.error = error ?? null;
    this.metrics = {
      executorId: metrics.executorId ?? null,
      startTime: metrics.startTime ?? null,
      endTime: metrics.endTime ?? null,
      cpuTimeMs: metrics.cpuTimeMs ?? 0,
      memoryPeakMb: metrics.memoryPeakMb ?? 0,
    };
  }

  /**
   * Wall-clock duration from start to end. Returns 0 when timestamps are
   * missing.
   * @returns {number}
   */
  get durationMs() {
    if (this.metrics.startTime == null || this.metrics.endTime == null) return 0;
    return this.metrics.endTime - this.metrics.startTime;
  }

  toJSON() {
    return {
      jobId: this.jobId,
      status: this.status,
      result: this.result,
      error: this.error,
      metrics: { ...this.metrics },
    };
  }

  /**
   * @param {object} data
   * @returns {ComputeResult}
   */
  static fromJSON(data) {
    return new ComputeResult({
      jobId: data.jobId,
      status: data.status,
      result: data.result,
      error: data.error,
      metrics: data.metrics,
    });
  }
}

// ---------------------------------------------------------------------------
// ResourceScorer
// ---------------------------------------------------------------------------

/**
 * Scores a ResourceDescriptor against a ComputeRequest to determine fitness.
 *
 * Scoring heuristic (0-100+ scale):
 *   - Base: 50 points for being online
 *   - Preference match (gpu/cpu): +20
 *   - preferRuntimeClass match: +60 / mismatch: -15
 *   - Isolation lane ('isolate'/'microvm' hard requirement; 'any' prefers
 *     isolate for js/wasm and microvm for shell, +25): see issue #185 §6
 *   - Memory headroom: up to +15
 *   - CPU count: up to +10
 *   - Bandwidth: up to +5
 *   - Busy penalty: -20
 */
export class ResourceScorer {
  /**
   * @param {ComputeRequest} request
   * @param {ResourceDescriptor} descriptor
   * @returns {number}
   */
  static score(request, descriptor) {
    let s = 0;

    // Availability base score
    if (descriptor.availability === 'online') s += 50;
    else if (descriptor.availability === 'busy') s += 30;
    else return 0; // offline nodes score zero

    // -- Isolation lane (issue #185 §6) --------------------------------------
    const isolation = request.constraints?.isolation ?? ISOLATION.ANY;
    const moduleType = request.moduleType;

    // A 'shell' module can only ever run in a microvm pod, regardless of the
    // requested isolation lane.
    if (moduleType === 'shell' && !descriptor.capabilities.includes(`runtime:${RUNTIME_CLASS.MICROVM}`)) {
      return 0;
    }

    if (isolation === ISOLATION.ISOLATE || isolation === ISOLATION.MICROVM) {
      if (!descriptor.capabilities.includes(`runtime:${isolation}`)) {
        return 0;
      }
    } else if (isolation === ISOLATION.ANY) {
      if (moduleType !== 'shell' && (moduleType === 'js' || moduleType === 'wasm')
        && descriptor.capabilities.includes(`runtime:${RUNTIME_CLASS.ISOLATE}`)) {
        s += 25;
      } else if (moduleType === 'shell' && descriptor.capabilities.includes(`runtime:${RUNTIME_CLASS.MICROVM}`)) {
        s += 25;
      }
    }

    // Preference match
    const prefer = request.constraints?.prefer ?? 'any';
    if (prefer === 'gpu' && descriptor.resources.gpu > 0) s += 20;
    else if (prefer === 'cpu' && descriptor.resources.cpu > 0) s += 20;
    else if (prefer === 'any') s += 10;

    const preferRuntimeClass = request.constraints?.preferRuntimeClass;
    if (preferRuntimeClass && descriptor.capabilities.includes(`runtime:${preferRuntimeClass}`)) {
      s += 60;
    } else if (preferRuntimeClass) {
      s -= 15;
    }

    // Memory headroom: up to +15
    const reqMem = request.constraints?.maxMemoryMb ?? 0;
    if (reqMem > 0 && descriptor.resources.memory > 0) {
      const ratio = Math.min(descriptor.resources.memory / reqMem, 4);
      s += Math.round((ratio / 4) * 15);
    } else if (descriptor.resources.memory > 0) {
      s += 8;
    }

    // CPU count: up to +10
    if (descriptor.resources.cpu > 0) {
      s += Math.min(descriptor.resources.cpu, 10);
    }

    // Bandwidth: up to +5
    if (descriptor.resources.bandwidth > 0) {
      s += Math.min(Math.round(descriptor.resources.bandwidth / 20), 5);
    }

    return s;
  }

  /**
   * Select the best-scoring descriptor for a request.
   *
   * @param {ComputeRequest} request
   * @param {ResourceDescriptor[]} descriptors
   * @returns {ResourceDescriptor|null}
   */
  static selectBest(request, descriptors) {
    if (!descriptors || descriptors.length === 0) return null;
    let best = null;
    let bestScore = -1;
    for (const desc of descriptors) {
      const s = ResourceScorer.score(request, desc);
      if (s > bestScore) {
        bestScore = s;
        best = desc;
      }
    }
    return best;
  }

  /**
   * Compute the effective placement lane for a request, for logging/audit
   * purposes (issue #185 §6/§8 WP4). Does not consult any descriptor -- it
   * is purely a function of the request's own `moduleType`/
   * `constraints.isolation`.
   *
   * @param {ComputeRequest} request
   * @returns {{ required: 'isolate'|'microvm'|null, preferred: 'isolate'|'microvm'|null }}
   *   `required` is set when the lane is a hard constraint (an explicit
   *   `isolation` of `'isolate'`/`'microvm'`, or `moduleType: 'shell'`
   *   which always requires `microvm`). `preferred` is set when
   *   `isolation` is `'any'` and the module type implies a preferred lane
   *   (`js`/`wasm` -> `isolate`, `shell` -> `microvm`).
   */
  static lane(request) {
    const isolation = request.constraints?.isolation ?? ISOLATION.ANY;
    const moduleType = request.moduleType;

    if (moduleType === 'shell') {
      return { required: RUNTIME_CLASS.MICROVM, preferred: null };
    }
    if (isolation === ISOLATION.ISOLATE || isolation === ISOLATION.MICROVM) {
      return { required: isolation, preferred: null };
    }
    if (moduleType === 'js' || moduleType === 'wasm') {
      return { required: null, preferred: RUNTIME_CLASS.ISOLATE };
    }
    return { required: null, preferred: null };
  }
}

// ---------------------------------------------------------------------------
// JobQueue
// ---------------------------------------------------------------------------

/** @typedef {'pending'|'assigned'|'running'|'completed'|'cancelled'|'timeout'|'error'} JobStatus */

/**
 * In-memory job queue for compute requests.
 */
export class JobQueue {
  /** @type {Map<string, object>} jobId -> job record */
  #jobs = new Map();
  #maxJobs;

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxJobs=256]
   */
  constructor(opts = {}) {
    this.#maxJobs = opts.maxJobs ?? 256;
  }

  /**
   * Submit a compute request to the queue.
   *
   * @param {ComputeRequest} request
   * @returns {string} jobId
   */
  submit(request) {
    if (this.#jobs.size >= this.#maxJobs) {
      throw new Error('JobQueue is full');
    }
    this.#jobs.set(request.jobId, {
      request,
      status: 'pending',
      assignedTo: null,
      result: null,
      submittedAt: Date.now(),
      startedAt: null,
      completedAt: null,
    });
    return request.jobId;
  }

  /**
   * Get a job record by ID.
   *
   * @param {string} jobId
   * @returns {object|null}
   */
  get(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) return null;
    return { ...job };
  }

  /**
   * Assign a pending job to an executor pod.
   *
   * @param {string} jobId
   * @param {string} executorPodId
   * @returns {boolean}
   */
  assign(jobId, executorPodId) {
    const job = this.#jobs.get(jobId);
    if (!job || job.status !== 'pending') return false;
    job.status = 'assigned';
    job.assignedTo = executorPodId;
    job.startedAt = Date.now();
    return true;
  }

  /**
   * Mark a job as completed with a ComputeResult.
   *
   * @param {string} jobId
   * @param {ComputeResult} result
   * @returns {boolean}
   */
  complete(jobId, result) {
    const job = this.#jobs.get(jobId);
    if (!job) return false;
    if (job.status !== 'pending' && job.status !== 'assigned') return false;
    job.status = result.status === 'success' ? 'completed' : result.status;
    job.result = result;
    job.completedAt = Date.now();
    return true;
  }

  /**
   * Cancel a pending or assigned job.
   *
   * @param {string} jobId
   * @param {string} [reason]
   * @returns {boolean}
   */
  cancel(jobId, reason) {
    const job = this.#jobs.get(jobId);
    if (!job) return false;
    if (job.status !== 'pending' && job.status !== 'assigned') return false;
    job.status = 'cancelled';
    job.result = new ComputeResult({
      jobId,
      status: 'cancelled',
      error: reason ?? 'Cancelled by requester',
    });
    job.completedAt = Date.now();
    return true;
  }

  /**
   * List all pending requests.
   * @returns {ComputeRequest[]}
   */
  listPending() {
    const results = [];
    for (const job of this.#jobs.values()) {
      if (job.status === 'pending') results.push(job.request);
    }
    return results;
  }

  /**
   * List jobs filtered by status.
   *
   * @param {string} status
   * @returns {object[]}
   */
  listByStatus(status) {
    const results = [];
    for (const job of this.#jobs.values()) {
      if (job.status === status) results.push({ ...job });
    }
    return results;
  }

  /** @returns {number} */
  get size() {
    return this.#jobs.size;
  }

  /**
   * Remove completed/cancelled/error/timeout jobs older than maxAgeMs.
   *
   * @param {number} [maxAgeMs=300000] - Default 5 minutes
   * @returns {number} count of jobs pruned
   */
  pruneCompleted(maxAgeMs = 300_000) {
    const cutoff = Date.now() - maxAgeMs;
    const terminal = new Set(['completed', 'cancelled', 'error', 'timeout']);
    let count = 0;
    for (const [jobId, job] of this.#jobs) {
      if (terminal.has(job.status) && job.completedAt && job.completedAt <= cutoff) {
        this.#jobs.delete(jobId);
        count++;
      }
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;

/** Generate a unique-ish job ID. */
function _genId() {
  return `job_${Date.now().toString(36)}_${(++_idCounter).toString(36)}`;
}
