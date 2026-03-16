/**
 * test-transport.mjs — In-memory transport for unit and integration testing.
 *
 * Provides LocalChannel (PodChannel implementation), TestMesh (multi-pod
 * fully-connected topology), and DeterministicRNG (seeded mulberry32).
 *
 * No browser dependencies. Zero external imports.
 *
 * Run tests:
 *   node --test web/packages/mesh-primitives/test/test-transport.test.mjs
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const TESTMESH_LIMITS = Object.freeze({
  maxPods: 64,
  maxQueueSize: 10_000,
  maxLatencyMs: 10_000,
  maxJitterMs: 5_000,
  maxConcurrentMeshes: 8,
})

// ---------------------------------------------------------------------------
// DeterministicRNG — mulberry32
// ---------------------------------------------------------------------------

export class DeterministicRNG {
  #state

  /** @param {number} [seed] */
  constructor(seed) {
    this.#state = seed ?? Date.now()
  }

  /** Return a pseudo-random float in [0, 1) */
  next() {
    this.#state |= 0
    this.#state = (this.#state + 0x6d2b79f5) | 0
    let t = Math.imul(this.#state ^ (this.#state >>> 15), 1 | this.#state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Reset to a new seed for replay */
  reset(seed) {
    this.#state = seed
  }
}

// ---------------------------------------------------------------------------
// LocalChannelOptions defaults
// ---------------------------------------------------------------------------

const LOCAL_CHANNEL_DEFAULTS = Object.freeze({
  latencyMs: 0,
  jitterMs: 0,
  dropRate: 0,
  reorderRate: 0,
  maxQueueSize: 1000,
  seed: undefined, // will use Date.now() in DeterministicRNG
})

// ---------------------------------------------------------------------------
// LocalChannel — in-memory PodChannel
// ---------------------------------------------------------------------------

/**
 * In-memory implementation of the PodChannel interface.
 * Paired via createLocalChannelPair(). Messages sent on one end are
 * delivered to the peer's onmessage handler with configurable latency,
 * jitter, drop rate, and reorder rate.
 */
export class LocalChannel {
  /** @type {string} */
  id

  /** @type {'message-port'} */
  type = 'message-port'

  /** @type {'connecting'|'open'|'closing'|'closed'} */
  state = 'open'

  /** @type {((event: {data: unknown, source?: LocalChannel}) => void)|null} */
  onmessage = null

  /** @type {((error: {code: string, message: string, fatal: boolean}) => void)|null} */
  onerror = null

  /** @type {(() => void)|null} */
  onclose = null

  /** @type {LocalChannel|null} */
  #peer = null

  /** @type {Array<{data: unknown, source?: LocalChannel}>} */
  #queue = []

  #options
  #rng
  #pendingTimers = new Set()

  /**
   * @param {string} [id]
   * @param {object} [options]
   */
  constructor(id, options) {
    this.id = id ?? `lc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.#options = { ...LOCAL_CHANNEL_DEFAULTS, ...options }
    this.#rng = new DeterministicRNG(this.#options.seed)
  }

  /** @internal Connect this channel to its peer */
  _setPeer(peer) {
    this.#peer = peer
  }

  /** @internal Expose options for fault injection */
  get _options() {
    return this.#options
  }

  /** Number of buffered messages */
  get queueLength() {
    return this.#queue.length
  }

  /**
   * Send a message to the paired channel.
   * Respects configured latency, jitter, drop rate, and reorder rate.
   *
   * @param {unknown} data
   * @param {Transferable[]} [_transfer] - Ignored (for PodChannel compat)
   */
  send(data, _transfer) {
    if (this.state !== 'open') {
      this.onerror?.({
        code: 'CHANNEL_CLOSED',
        message: 'Cannot send on closed channel',
        fatal: false,
      })
      return
    }

    if (!this.#peer || this.#peer.state !== 'open') {
      this.onerror?.({
        code: 'PEER_CLOSED',
        message: 'Peer channel is closed',
        fatal: false,
      })
      return
    }

    // Check queue capacity on peer
    if (this.#peer.#queue.length >= this.#options.maxQueueSize) {
      this.onerror?.({
        code: 'QUEUE_FULL',
        message: `Queue size exceeded (max: ${this.#options.maxQueueSize})`,
        fatal: false,
      })
      return
    }

    // Simulate message drop
    if (this.#rng.next() < this.#options.dropRate) {
      return // Message silently dropped
    }

    const event = {
      data: structuredClone(data),
      source: this,
    }

    // Compute delivery delay
    const baseLatency = this.#options.latencyMs
    const jitter = this.#options.jitterMs * (this.#rng.next() * 2 - 1)
    const delay = Math.max(0, baseLatency + jitter)

    // Simulate reordering by adding extra random delay
    const reorderDelay = this.#rng.next() < this.#options.reorderRate
      ? this.#rng.next() * baseLatency * 2
      : 0

    const totalDelay = delay + reorderDelay

    // Schedule delivery
    if (totalDelay === 0) {
      this.#peer.#deliver(event)
    } else {
      const peer = this.#peer
      const timer = setTimeout(() => {
        this.#pendingTimers.delete(timer)
        if (peer.state === 'open') {
          peer.#deliver(event)
        }
      }, totalDelay)
      this.#pendingTimers.add(timer)
    }
  }

  /** Close the channel and notify the peer */
  close() {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.#queue.length = 0
    // Clear pending timers
    for (const timer of this.#pendingTimers) {
      clearTimeout(timer)
    }
    this.#pendingTimers.clear()
    this.onclose?.()
  }

  /** Async iterator for consuming messages in tests */
  [Symbol.asyncIterator]() {
    return new LocalChannelIterator(this, this.#queue)
  }

  /** @internal Deliver a message to this channel's handler */
  #deliver(event) {
    if (this.state !== 'open') return
    this.#queue.push(event)
    this.onmessage?.(event)
  }
}

// ---------------------------------------------------------------------------
// LocalChannelIterator — AsyncIterator adapter
// ---------------------------------------------------------------------------

class LocalChannelIterator {
  #buffer = []
  #resolve = null
  #done = false

  constructor(channel, existingQueue) {
    // Drain any already-buffered messages
    if (existingQueue && existingQueue.length > 0) {
      this.#buffer.push(...existingQueue)
    }

    const originalOnMessage = channel.onmessage
    channel.onmessage = (event) => {
      originalOnMessage?.(event)
      if (this.#resolve) {
        const r = this.#resolve
        this.#resolve = null
        r({ value: event, done: false })
      } else {
        this.#buffer.push(event)
      }
    }

    const originalOnClose = channel.onclose
    channel.onclose = () => {
      originalOnClose?.()
      this.#done = true
      if (this.#resolve) {
        const r = this.#resolve
        this.#resolve = null
        r({ value: undefined, done: true })
      }
    }
  }

  async next() {
    if (this.#buffer.length > 0) {
      return { value: this.#buffer.shift(), done: false }
    }
    if (this.#done) {
      return { value: undefined, done: true }
    }
    return new Promise((resolve) => {
      this.#resolve = resolve
    })
  }

  [Symbol.asyncIterator]() {
    return this
  }
}

// ---------------------------------------------------------------------------
// createLocalChannelPair
// ---------------------------------------------------------------------------

/**
 * Create two connected LocalChannel instances.
 * Like MessageChannel, but fully in-memory with configurable faults.
 *
 * @param {object} [options] - LocalChannelOptions
 * @returns {[LocalChannel, LocalChannel]}
 */
export function createLocalChannelPair(options) {
  const idA = `lc_a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const idB = `lc_b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  const channelA = new LocalChannel(idA, options)
  const channelB = new LocalChannel(idB, options)

  channelA._setPeer(channelB)
  channelB._setPeer(channelA)

  return [channelA, channelB]
}

// ---------------------------------------------------------------------------
// TestMesh — multi-pod fully-connected topology
// ---------------------------------------------------------------------------

/**
 * Creates a fully-connected mesh of test pods with LocalChannel pairs
 * between every pod. Supports fault injection (partition, latency, drop).
 */
export class TestMesh {
  /** @type {Array<{id: string, kind: string, channels: Map<number, LocalChannel>}>} */
  pods

  /** @type {Map<string, LocalChannel>} */
  #channels = new Map()

  /** @type {object} */
  #defaultOptions

  /** @param {Array} pods */
  constructor(pods, defaultOptions) {
    this.pods = pods
    this.#defaultOptions = defaultOptions || {}
  }

  /**
   * Create a mesh of n pods with LocalChannel connections between all pairs.
   * For n pods, creates n*(n-1)/2 channel pairs.
   *
   * @param {number} n - Number of pods (2-64)
   * @param {object} [options]
   * @returns {Promise<TestMesh>}
   */
  static async create(n, options) {
    if (n < 2 || n > TESTMESH_LIMITS.maxPods) {
      throw new Error(`Pod count must be between 2 and ${TESTMESH_LIMITS.maxPods}`)
    }

    const kinds = options?.kinds ?? ['worker']
    const pods = []

    for (let i = 0; i < n; i++) {
      pods.push({
        id: `test-pod-${i}`,
        kind: kinds[i % kinds.length],
        channels: new Map(),
      })
    }

    const mesh = new TestMesh(pods, options)

    // Create channel pairs between all pods
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const [channelA, channelB] = createLocalChannelPair(options)
        pods[i].channels.set(j, channelA)
        pods[j].channels.set(i, channelB)
        mesh.#channels.set(`${i}-${j}`, channelA)
        mesh.#channels.set(`${j}-${i}`, channelB)
      }
    }

    return mesh
  }

  /**
   * Get the LocalChannel from pod at fromIndex to pod at toIndex.
   *
   * @param {number} fromIndex
   * @param {number} toIndex
   * @returns {LocalChannel}
   */
  getChannel(fromIndex, toIndex) {
    const channel = this.#channels.get(`${fromIndex}-${toIndex}`)
    if (!channel) {
      throw new Error(`No channel from pod ${fromIndex} to pod ${toIndex}`)
    }
    return channel
  }

  /**
   * Inject a fault into the mesh.
   *
   * @param {{ type: 'partition'|'latency'|'message-drop', [key: string]: * }} fault
   */
  injectFault(fault) {
    switch (fault.type) {
      case 'partition':
        this.#injectPartition(fault)
        break
      case 'latency':
        this.#injectLatency(fault)
        break
      case 'message-drop':
        this.#injectMessageDrop(fault)
        break
      default:
        throw new Error(`Unsupported fault type for TestMesh: ${fault.type}`)
    }
  }

  #injectPartition(fault) {
    for (const podA of this.pods) {
      if (!fault.groupA.includes(podA.id)) continue
      for (const podB of this.pods) {
        if (!fault.groupB.includes(podB.id)) continue
        const idxA = this.pods.indexOf(podA)
        const idxB = this.pods.indexOf(podB)

        // Close both directions
        this.#channels.get(`${idxA}-${idxB}`)?.close()
        this.#channels.get(`${idxB}-${idxA}`)?.close()
      }
    }

    // Auto-heal after duration
    if (fault.duration && fault.duration > 0) {
      setTimeout(() => this.#healPartition(fault), fault.duration)
    }
  }

  #healPartition(fault) {
    for (const podA of this.pods) {
      if (!fault.groupA.includes(podA.id)) continue
      for (const podB of this.pods) {
        if (!fault.groupB.includes(podB.id)) continue
        const idxA = this.pods.indexOf(podA)
        const idxB = this.pods.indexOf(podB)

        const [channelA, channelB] = createLocalChannelPair(this.#defaultOptions)
        podA.channels.set(idxB, channelA)
        podB.channels.set(idxA, channelB)
        this.#channels.set(`${idxA}-${idxB}`, channelA)
        this.#channels.set(`${idxB}-${idxA}`, channelB)
      }
    }
  }

  #injectLatency(fault) {
    for (const pod of this.pods) {
      if (fault.targets[0] !== '*' && !fault.targets.includes(pod.id)) continue
      for (const [_, channel] of pod.channels) {
        channel._options.latencyMs = fault.delayMs
        channel._options.jitterMs = fault.jitterMs ?? 0
      }
    }
  }

  #injectMessageDrop(fault) {
    for (const pod of this.pods) {
      if (!fault.targets.includes(pod.id)) continue
      for (const [_, channel] of pod.channels) {
        channel._options.dropRate = fault.dropRate
      }
    }
  }

  /** Shut down all pods and close all channels */
  async shutdown() {
    for (const [_, channel] of this.#channels) {
      channel.close()
    }
    this.#channels.clear()
    for (const pod of this.pods) {
      pod.channels.clear()
    }
  }
}
