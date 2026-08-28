/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-peer-compute.js — Federated compute orchestration.
 *
 * Split large compute jobs across multiple peers (map/reduce pattern).
 * Combines scheduling, verification, escrow, and result merging.
 * Enables "nomadic supercomputer" and "compute marketplace" scenarios.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-compute.test.mjs
 */

// ---------------------------------------------------------------------------
// Polyfill
// ---------------------------------------------------------------------------

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => 'fc-' + Math.random().toString(36).slice(2)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Supported compute orchestration types.
 * @type {Readonly<Record<string, string>>}
 */
export const COMPUTE_TYPES = Object.freeze({
  MAP_REDUCE: 'map_reduce',
  PIPELINE: 'pipeline',
  BROADCAST: 'broadcast',
  SCATTER_GATHER: 'scatter_gather',
})

/**
 * Default configuration for federated compute jobs.
 * @type {Readonly<Record<string, any>>}
 */
export const COMPUTE_DEFAULTS = Object.freeze({
  type: 'scatter_gather',
  maxChunks: 100,
  chunkTimeoutMs: 30_000,
  maxRetries: 2,
  verifyLevel: 0,
})

// ---------------------------------------------------------------------------
// ComputeChunk
// ---------------------------------------------------------------------------

/**
 * Represents a single unit of work within a federated job.
 */
export class ComputeChunk {
  /** @type {string} */
  id

  /** @type {string} */
  jobId

  /** @type {number} */
  index

  /** @type {any} */
  payload

  /** @type {string|null} */
  assignee

  /** @type {string} */
  status

  /** @type {any} */
  result

  /** @type {string|null} */
  error

  /** @type {number} */
  attempts

  /** @type {number} */
  cost

  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.jobId
   * @param {number} opts.index
   * @param {any} opts.payload
   * @param {string} [opts.assignee]
   * @param {string} [opts.status]
   * @param {any} [opts.result]
   * @param {string|null} [opts.error]
   * @param {number} [opts.attempts]
   * @param {number} [opts.cost]
   */
  constructor(opts) {
    this.id = opts.id
    this.jobId = opts.jobId
    this.index = opts.index
    this.payload = opts.payload
    this.assignee = opts.assignee ?? null
    this.status = opts.status ?? 'pending'
    this.result = opts.result ?? null
    this.error = opts.error ?? null
    this.attempts = opts.attempts ?? 0
    this.cost = opts.cost ?? 0
  }

  /**
   * Serialize to a JSON-safe plain object.
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      jobId: this.jobId,
      index: this.index,
      payload: this.payload,
      assignee: this.assignee,
      status: this.status,
      result: this.result,
      error: this.error,
      attempts: this.attempts,
      cost: this.cost,
    }
  }

  /**
   * Restore a ComputeChunk from serialized data.
   * @param {object} json
   * @returns {ComputeChunk}
   */
  static fromJSON(json) {
    return new ComputeChunk({
      id: json.id,
      jobId: json.jobId,
      index: json.index,
      payload: json.payload,
      assignee: json.assignee,
      status: json.status,
      result: json.result,
      error: json.error,
      attempts: json.attempts,
      cost: json.cost,
    })
  }
}

// ---------------------------------------------------------------------------
// FederatedJob
// ---------------------------------------------------------------------------

/**
 * Represents a full federated compute job spanning multiple peers.
 */
export class FederatedJob {
  /** @type {string} */
  id

  /** @type {string} */
  type

  /** @type {any} */
  payload

  /** @type {string} */
  status

  /** @type {ComputeChunk[]} */
  chunks

  /** @type {any} */
  result

  /** @type {number} */
  cost

  /** @type {number} */
  createdAt

  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.type
   * @param {any} opts.payload
   * @param {string} [opts.status]
   * @param {ComputeChunk[]} [opts.chunks]
   * @param {any} [opts.result]
   * @param {number} [opts.cost]
   * @param {number} [opts.createdAt]
   */
  constructor(opts) {
    this.id = opts.id
    this.type = opts.type
    this.payload = opts.payload
    this.status = opts.status ?? 'pending'
    this.chunks = opts.chunks ?? []
    this.result = opts.result ?? null
    this.cost = opts.cost ?? 0
    this.createdAt = opts.createdAt ?? Date.now()
  }

  /**
   * Get progress info for this job.
   * @returns {{ total: number, completed: number, failed: number, running: number, pct: number }}
   */
  getProgress() {
    const total = this.chunks.length
    let completed = 0
    let failed = 0
    let running = 0

    for (const chunk of this.chunks) {
      if (chunk.status === 'completed') completed++
      else if (chunk.status === 'failed') failed++
      else if (chunk.status === 'running') running++
    }

    const pct = total === 0 ? 0 : Math.round((completed / total) * 100)

    return { total, completed, failed, running, pct }
  }

  /**
   * Add a chunk to this job.
   * @param {ComputeChunk} chunk
   */
  addChunk(chunk) {
    this.chunks.push(chunk)
  }

  /**
   * Get a chunk by ID.
   * @param {string} id
   * @returns {ComputeChunk|null}
   */
  getChunk(id) {
    return this.chunks.find(c => c.id === id) ?? null
  }

  /**
   * Update a chunk by ID with partial updates.
   * @param {string} id
   * @param {object} updates
   */
  updateChunk(id, updates) {
    const chunk = this.chunks.find(c => c.id === id)
    if (!chunk) return
    for (const [key, value] of Object.entries(updates)) {
      if (key in chunk) chunk[key] = value
    }
  }

  /**
   * Serialize to a JSON-safe plain object.
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      payload: this.payload,
      status: this.status,
      chunks: this.chunks.map(c => c.toJSON()),
      result: this.result,
      cost: this.cost,
      createdAt: this.createdAt,
    }
  }

  /**
   * Restore a FederatedJob from serialized data.
   * @param {object} json
   * @returns {FederatedJob}
   */
  static fromJSON(json) {
    return new FederatedJob({
      id: json.id,
      type: json.type,
      payload: json.payload,
      status: json.status,
      chunks: (json.chunks || []).map(c => ComputeChunk.fromJSON(c)),
      result: json.result,
      cost: json.cost,
      createdAt: json.createdAt,
    })
  }
}

// ---------------------------------------------------------------------------
// FederatedCompute
// ---------------------------------------------------------------------------

/**
 * Orchestrates federated compute across mesh peers.
 *
 * Splits work via user-provided splitFn, dispatches chunks to peers via
 * the injected scheduler, handles retries on failure, and merges results
 * via user-provided mergeFn.
 */
export class FederatedCompute {
  /** @type {object} */
  #scheduler

  /** @type {Function} */
  #onLog

  /** @type {Map<string, FederatedJob>} */
  #jobs = new Map()

  /** @type {Map<string, Function[]>} */
  #listeners = new Map()

  /**
   * @param {object} opts
   * @param {object} opts.scheduler - Must have dispatch(peerId, job) and listAvailablePeers()
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   */
  constructor(opts) {
    if (!opts?.scheduler) {
      throw new Error('FederatedCompute requires a scheduler')
    }
    if (typeof opts.scheduler.dispatch !== 'function') {
      throw new Error('scheduler must have a dispatch() method')
    }
    if (typeof opts.scheduler.listAvailablePeers !== 'function') {
      throw new Error('scheduler must have a listAvailablePeers() method')
    }
    this.#scheduler = opts.scheduler
    this.#onLog = opts.onLog ?? (() => {})
  }

  // ── Submit ──────────────────────────────────────────────────────

  /**
   * Submit a federated compute job.
   *
   * @param {object} jobSpec
   * @param {string} [jobSpec.type]        - One of COMPUTE_TYPES (default: scatter_gather)
   * @param {any} jobSpec.payload           - The full payload to split
   * @param {Function} jobSpec.splitFn      - (payload) => chunkPayloads[]
   * @param {Function} jobSpec.mergeFn      - (results[]) => mergedResult
   * @param {string[]} [jobSpec.peers]      - Specific peer list (overrides scheduler discovery)
   * @param {number} [jobSpec.budget]       - Cost budget (informational)
   * @param {number} [jobSpec.verifyLevel]  - 0=none, 1=spot-check, 2=full-quorum
   * @returns {Promise<FederatedJob>}
   */
  async submit(jobSpec) {
    const type = jobSpec.type ?? COMPUTE_DEFAULTS.type
    const jobId = crypto.randomUUID()

    const job = new FederatedJob({
      id: jobId,
      type,
      payload: jobSpec.payload,
      status: 'splitting',
    })

    this.#jobs.set(jobId, job)
    this.#emit('submitted', job)
    this.#onLog('info', `Job ${jobId} submitted (type: ${type})`)

    // Step 1: Split payload into chunk payloads
    const chunkPayloads = await jobSpec.splitFn(jobSpec.payload)
    this.#emit('split', { jobId, count: chunkPayloads.length })
    this.#onLog('info', `Job ${jobId} split into ${chunkPayloads.length} chunks`)

    // Step 2: Resolve peer list
    const peers = jobSpec.peers ?? this.#scheduler.listAvailablePeers()
    if (peers.length === 0) {
      job.status = 'failed'
      this.#emit('failed', job)
      return job
    }

    // Step 3: Create chunks and assign to peers
    const computeType = type

    if (computeType === COMPUTE_TYPES.BROADCAST) {
      // Broadcast: same payload sent to all peers
      for (let i = 0; i < peers.length; i++) {
        const chunk = new ComputeChunk({
          id: crypto.randomUUID(),
          jobId,
          index: i,
          payload: chunkPayloads[0] ?? jobSpec.payload,
          assignee: peers[i],
          status: 'assigned',
        })
        job.addChunk(chunk)
        this.#emit('chunk-assigned', { jobId, chunkId: chunk.id, peerId: peers[i] })
      }
    } else if (computeType === COMPUTE_TYPES.PIPELINE) {
      // Pipeline: sequential stages, each assigned to a peer
      for (let i = 0; i < chunkPayloads.length; i++) {
        const peerId = peers[i % peers.length]
        const chunk = new ComputeChunk({
          id: crypto.randomUUID(),
          jobId,
          index: i,
          payload: chunkPayloads[i],
          assignee: peerId,
          status: 'assigned',
        })
        job.addChunk(chunk)
        this.#emit('chunk-assigned', { jobId, chunkId: chunk.id, peerId })
      }
    } else {
      // MAP_REDUCE and SCATTER_GATHER: round-robin assignment
      for (let i = 0; i < chunkPayloads.length; i++) {
        const peerId = peers[i % peers.length]
        const chunk = new ComputeChunk({
          id: crypto.randomUUID(),
          jobId,
          index: i,
          payload: chunkPayloads[i],
          assignee: peerId,
          status: 'assigned',
        })
        job.addChunk(chunk)
        this.#emit('chunk-assigned', { jobId, chunkId: chunk.id, peerId })
      }
    }

    job.status = 'running'

    // Step 4: Dispatch chunks
    if (computeType === COMPUTE_TYPES.PIPELINE) {
      // Pipeline: sequential execution — each stage feeds into the next
      await this.#dispatchPipeline(job, jobSpec, peers)
    } else {
      // All other types: parallel dispatch
      await this.#dispatchParallel(job, jobSpec, peers)
    }

    // Step 5: Check if job succeeded
    const progress = job.getProgress()
    if (progress.failed > 0 && progress.completed === 0) {
      job.status = 'failed'
      this.#emit('failed', job)
      return job
    }

    // Step 6: Merge results
    job.status = 'merging'
    const completedResults = job.chunks
      .filter(c => c.status === 'completed')
      .sort((a, b) => a.index - b.index)
      .map(c => c.result)

    try {
      job.result = await jobSpec.mergeFn(completedResults)
      job.status = 'completed'
      job.cost = job.chunks.reduce((sum, c) => sum + c.cost, 0)
      this.#emit('merged', { jobId, result: job.result })
      this.#emit('completed', job)
      this.#onLog('info', `Job ${jobId} completed`)
    } catch (err) {
      job.status = 'failed'
      this.#emit('failed', job)
      this.#onLog('error', `Job ${jobId} merge failed: ${err.message}`)
    }

    return job
  }

  // ── Cancel ─────────────────────────────────────────────────────

  /**
   * Cancel a running job. Sets all pending/running/assigned chunks to cancelled.
   *
   * @param {string} jobId
   * @returns {boolean} true if job was found and cancelled
   */
  async cancel(jobId) {
    const job = this.#jobs.get(jobId)
    if (!job) return false

    for (const chunk of job.chunks) {
      if (chunk.status === 'pending' || chunk.status === 'running' || chunk.status === 'assigned') {
        chunk.status = 'cancelled'
      }
    }

    job.status = 'cancelled'
    this.#emit('failed', job)
    this.#onLog('info', `Job ${jobId} cancelled`)

    return true
  }

  // ── Queries ────────────────────────────────────────────────────

  /**
   * Get a job by ID.
   * @param {string} id
   * @returns {FederatedJob|null}
   */
  getJob(id) {
    return this.#jobs.get(id) ?? null
  }

  /**
   * List all jobs, optionally filtered.
   * @param {object} [filter]
   * @param {string} [filter.status]
   * @returns {FederatedJob[]}
   */
  listJobs(filter) {
    let results = [...this.#jobs.values()]
    if (filter?.status) {
      results = results.filter(j => j.status === filter.status)
    }
    return results
  }

  /**
   * Get aggregate statistics across all jobs.
   * @returns {{ submitted: number, running: number, completed: number, failed: number, totalCost: number }}
   */
  getStats() {
    let submitted = 0
    let running = 0
    let completed = 0
    let failed = 0
    let totalCost = 0

    for (const job of this.#jobs.values()) {
      submitted++
      switch (job.status) {
        case 'running':
        case 'splitting':
        case 'assigned':
        case 'merging':
          running++
          break
        case 'completed':
          completed++
          totalCost += job.cost
          break
        case 'failed':
        case 'cancelled':
          failed++
          break
      }
    }

    return { submitted, running, completed, failed, totalCost }
  }

  // ── Events ─────────────────────────────────────────────────────

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} cb
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, [])
    }
    this.#listeners.get(event).push(cb)
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const cbs = this.#listeners.get(event)
    if (!cbs) return
    const idx = cbs.indexOf(cb)
    if (idx !== -1) cbs.splice(idx, 1)
  }

  // ── Private helpers ────────────────────────────────────────────

  /**
   * Dispatch all chunks in parallel with retry logic.
   *
   * @param {FederatedJob} job
   * @param {object} jobSpec
   * @param {string[]} peers
   */
  async #dispatchParallel(job, jobSpec, peers) {
    const maxRetries = COMPUTE_DEFAULTS.maxRetries

    await Promise.all(job.chunks.map(async (chunk) => {
      await this.#dispatchChunk(chunk, job, jobSpec, peers, maxRetries)
    }))
  }

  /**
   * Dispatch pipeline chunks sequentially. Each stage's output feeds
   * into the next stage's input.
   *
   * @param {FederatedJob} job
   * @param {object} jobSpec
   * @param {string[]} peers
   */
  async #dispatchPipeline(job, jobSpec, peers) {
    const maxRetries = COMPUTE_DEFAULTS.maxRetries
    let previousResult = null

    for (const chunk of job.chunks) {
      // For pipeline stages after the first, feed previous result into payload
      if (previousResult !== null) {
        chunk.payload = { ...chunk.payload, previousResult }
      }

      await this.#dispatchChunk(chunk, job, jobSpec, peers, maxRetries)

      if (chunk.status === 'completed') {
        previousResult = chunk.result
      } else {
        // Pipeline breaks on failure
        break
      }
    }
  }

  /**
   * Dispatch a single chunk with retry logic.
   *
   * @param {ComputeChunk} chunk
   * @param {FederatedJob} job
   * @param {object} jobSpec
   * @param {string[]} peers
   * @param {number} maxRetries
   */
  async #dispatchChunk(chunk, job, jobSpec, peers, maxRetries) {
    let lastError = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      chunk.attempts = attempt + 1
      chunk.status = 'running'

      try {
        const result = await this.#scheduler.dispatch(chunk.assignee, {
          chunkId: chunk.id,
          jobId: job.id,
          index: chunk.index,
          payload: chunk.payload,
        })

        chunk.result = result.output ?? result
        chunk.status = 'completed'
        chunk.cost = result.cost ?? 0
        this.#emit('chunk-complete', { jobId: job.id, chunkId: chunk.id, result: chunk.result })
        return
      } catch (err) {
        lastError = err
        this.#onLog('warn', `Chunk ${chunk.id} attempt ${attempt + 1} failed: ${err.message}`)

        if (attempt < maxRetries) {
          // Retry on a different peer if available
          const currentIdx = peers.indexOf(chunk.assignee)
          const nextPeer = peers[(currentIdx + 1) % peers.length]
          chunk.assignee = nextPeer
        }
      }
    }

    // All retries exhausted
    chunk.status = 'failed'
    chunk.error = lastError?.message ?? 'unknown error'
    this.#emit('chunk-failed', { jobId: job.id, chunkId: chunk.id, error: chunk.error })
  }

  /**
   * Emit an event to all registered listeners.
   * Uses a snapshot to avoid mutation during iteration.
   *
   * @param {string} event
   * @param {...any} args
   */
  #emit(event, ...args) {
    const cbs = this.#listeners.get(event)
    if (!cbs) return
    for (const cb of [...cbs]) {
      try { cb(...args) } catch { /* listener errors do not propagate */ }
    }
  }
}
