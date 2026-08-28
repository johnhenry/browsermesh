import { silentCatch } from './silent-catch.mjs'
/**
// STATUS: EXPERIMENTAL — production hardening for BrowserMesh transports
 * clawser-mesh-hardening.js -- Production Hardening Layer.
 *
 * Additive hardening primitives that compose with existing MeshTransport
 * and MeshTransportNegotiator without breaking backward compatibility.
 *
 * Features:
 *   1. RetryWithBackoff    — exponential backoff + circuit breaker
 *   2. TransportHealthCheck — ping/pong liveness probes
 *   3. ConnectionPool       — per-peer pooling with idle eviction
 *   4. TransportMetrics     — per-transport byte/message/error/latency counters
 *   5. TransportFailover    — graceful degradation across transport types
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-hardening.test.mjs
 */

// ---------------------------------------------------------------------------
// 1. RetryWithBackoff — exponential backoff with circuit breaker
// ---------------------------------------------------------------------------

/**
 * Circuit breaker states.
 * @type {readonly string[]}
 */
export const CIRCUIT_STATES = Object.freeze(['closed', 'open', 'half-open']);

/**
 * Wraps an async operation with exponential backoff retry and circuit breaker.
 *
 * Circuit breaker transitions:
 *   closed    -> open       (after maxRetries consecutive failures)
 *   open      -> half-open  (after resetTimeoutMs elapses)
 *   half-open -> closed     (on next success)
 *   half-open -> open       (on next failure)
 *
 * @example
 * const retry = new RetryWithBackoff({ maxRetries: 5 });
 * const transport = await retry.execute(() => negotiator.negotiate(endpoints));
 */
export class RetryWithBackoff {
  /** @type {number} */
  #maxRetries;

  /** @type {number} */
  #baseDelayMs;

  /** @type {number} */
  #maxDelayMs;

  /** @type {number} */
  #jitterFactor;

  /** @type {number} */
  #resetTimeoutMs;

  /** @type {string} */
  #circuitState = 'closed';

  /** @type {number} */
  #failureCount = 0;

  /** @type {number} */
  #lastFailureTime = 0;

  /** @type {number} */
  #successCount = 0;

  /** @type {Function} */
  #nowFn;

  /** @type {Function} */
  #sleepFn;

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxRetries=5]        - Maximum retry attempts before circuit opens
   * @param {number} [opts.baseDelayMs=1000]    - Initial backoff delay
   * @param {number} [opts.maxDelayMs=30000]    - Maximum backoff delay cap
   * @param {number} [opts.jitterFactor=0.2]    - Random jitter factor (0-1)
   * @param {number} [opts.resetTimeoutMs=60000] - Time before circuit transitions open -> half-open
   * @param {Function} [opts.nowFn=Date.now]    - Clock function (for testing)
   * @param {Function} [opts.sleepFn]           - Sleep function (for testing)
   */
  constructor(opts = {}) {
    this.#maxRetries = opts.maxRetries ?? 5;
    this.#baseDelayMs = opts.baseDelayMs ?? 1000;
    this.#maxDelayMs = opts.maxDelayMs ?? 30000;
    this.#jitterFactor = opts.jitterFactor ?? 0.2;
    this.#resetTimeoutMs = opts.resetTimeoutMs ?? 60000;
    this.#nowFn = opts.nowFn ?? Date.now;
    this.#sleepFn = opts.sleepFn ?? ((ms) => new Promise(r => setTimeout(r, ms)));
  }

  /** Current circuit breaker state. */
  get circuitState() {
    return this.#circuitState;
  }

  /** Number of consecutive failures. */
  get failureCount() {
    return this.#failureCount;
  }

  /** Number of consecutive successes since last failure. */
  get successCount() {
    return this.#successCount;
  }

  /**
   * Execute an async operation with retry and circuit breaker logic.
   *
   * @template T
   * @param {() => Promise<T>} fn - The async operation to execute
   * @returns {Promise<T>}
   * @throws {Error} When circuit is open or all retries exhausted
   */
  async execute(fn) {
    // Check circuit breaker state
    if (this.#circuitState === 'open') {
      const elapsed = this.#nowFn() - this.#lastFailureTime;
      if (elapsed < this.#resetTimeoutMs) {
        throw new Error(`Circuit breaker is open (resets in ${this.#resetTimeoutMs - elapsed}ms)`);
      }
      // Transition to half-open — allow one attempt
      this.#circuitState = 'half-open';
    }

    const errors = [];
    const maxAttempts = this.#circuitState === 'half-open' ? 1 : this.#maxRetries;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const delay = this.#calculateDelay(attempt);
        await this.#sleepFn(delay);
      }

      try {
        const result = await fn();
        // Success — reset failure tracking, close circuit if half-open
        this.#failureCount = 0;
        this.#successCount++;
        if (this.#circuitState === 'half-open') {
          this.#circuitState = 'closed';
        }
        return result;
      } catch (err) {
        errors.push({ attempt: attempt + 1, error: err.message });
        this.#failureCount++;
        this.#successCount = 0;
        this.#lastFailureTime = this.#nowFn();
      }
    }

    // All attempts exhausted — check if circuit should open
    if (this.#failureCount >= this.#maxRetries) {
      this.#circuitState = 'open';
    }
    const msg = this.#circuitState === 'open'
      ? `Circuit breaker opened after ${this.#failureCount} failures`
      : `All ${maxAttempts} retries exhausted`;
    const error = new Error(`${msg}: ${JSON.stringify(errors)}`);
    error.attempts = errors;
    throw error;
  }

  /**
   * Manually reset the circuit breaker to closed state.
   */
  reset() {
    this.#circuitState = 'closed';
    this.#failureCount = 0;
    this.#successCount = 0;
    this.#lastFailureTime = 0;
  }

  /**
   * Serialize state for inspection.
   * @returns {object}
   */
  toJSON() {
    return {
      circuitState: this.#circuitState,
      failureCount: this.#failureCount,
      successCount: this.#successCount,
      maxRetries: this.#maxRetries,
      lastFailureTime: this.#lastFailureTime,
    };
  }

  // -- Internal ---------------------------------------------------------------

  /**
   * Calculate delay for a given attempt using exponential backoff + jitter.
   * @param {number} attempt - Zero-based attempt index
   * @returns {number} Delay in ms
   */
  #calculateDelay(attempt) {
    const exponential = this.#baseDelayMs * Math.pow(2, attempt - 1);
    const capped = Math.min(exponential, this.#maxDelayMs);
    const jitter = capped * this.#jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, Math.floor(capped + jitter));
  }

}

// ---------------------------------------------------------------------------
// 2. TransportHealthCheck — ping/pong liveness probes
// ---------------------------------------------------------------------------

/**
 * Health status values for a transport.
 * @type {readonly string[]}
 */
export const TRANSPORT_HEALTH_STATUSES = Object.freeze(['healthy', 'degraded', 'unhealthy']);

/**
 * Monitors transport liveness via periodic ping/pong probes.
 *
 * Sends a ping at `intervalMs`. If a pong is not received within
 * `timeoutMs`, the probe counts as missed. After `maxMissed` consecutive
 * misses the transport is marked unhealthy.
 *
 * @example
 * const check = new TransportHealthCheck({ transport, pingFn, pongEvent: 'message' });
 * check.start();
 * check.on('unhealthy', () => console.log('transport down'));
 */
export class TransportHealthCheck {
  /** @type {object} */
  #transport;

  /** @type {Function} */
  #pingFn;

  /** @type {number} */
  #intervalMs;

  /** @type {number} */
  #timeoutMs;

  /** @type {number} */
  #maxMissed;

  /** @type {number} */
  #missedCount = 0;

  /** @type {string} */
  #status = 'healthy';

  /** @type {number} */
  #lastPongTime = 0;

  /** @type {number} */
  #totalPings = 0;

  /** @type {number} */
  #totalPongs = 0;

  /** @type {*} */
  #intervalTimer = null;

  /** @type {*} */
  #timeoutTimer = null;

  /** @type {boolean} */
  #waitingForPong = false;

  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();

  /** @type {Function} */
  #nowFn;

  /**
   * @param {object} opts
   * @param {object} opts.transport       - Transport instance to monitor
   * @param {Function} opts.pingFn        - Function to send a ping (receives transport)
   * @param {number} [opts.intervalMs=10000] - Ping interval
   * @param {number} [opts.timeoutMs=5000]  - Max wait for pong response
   * @param {number} [opts.maxMissed=3]     - Consecutive misses before unhealthy
   * @param {Function} [opts.nowFn=Date.now]
   */
  constructor(opts) {
    if (!opts.transport) throw new Error('transport is required');
    if (!opts.pingFn || typeof opts.pingFn !== 'function') throw new Error('pingFn is required');
    this.#transport = opts.transport;
    this.#pingFn = opts.pingFn;
    this.#intervalMs = opts.intervalMs ?? 10000;
    this.#timeoutMs = opts.timeoutMs ?? 5000;
    this.#maxMissed = opts.maxMissed ?? 3;
    this.#nowFn = opts.nowFn ?? Date.now;
    this.#lastPongTime = this.#nowFn();
  }

  /** Current health status. */
  get status() {
    return this.#status;
  }

  /** Number of consecutive missed pongs. */
  get missedCount() {
    return this.#missedCount;
  }

  /** Total pings sent. */
  get totalPings() {
    return this.#totalPings;
  }

  /** Total pongs received. */
  get totalPongs() {
    return this.#totalPongs;
  }

  /** Timestamp of last pong. */
  get lastPongTime() {
    return this.#lastPongTime;
  }

  /** The transport being monitored. */
  get transport() {
    return this.#transport;
  }

  /**
   * Start periodic health checks.
   */
  start() {
    this.stop();
    this.#intervalTimer = setInterval(() => this.#sendPing(), this.#intervalMs);
  }

  /**
   * Stop periodic health checks.
   */
  stop() {
    if (this.#intervalTimer !== null) {
      clearInterval(this.#intervalTimer);
      this.#intervalTimer = null;
    }
    if (this.#timeoutTimer !== null) {
      clearTimeout(this.#timeoutTimer);
      this.#timeoutTimer = null;
    }
  }

  /**
   * Record a pong response. Call this externally when a pong arrives.
   */
  recordPong() {
    this.#totalPongs++;
    this.#lastPongTime = this.#nowFn();
    this.#missedCount = 0;
    this.#waitingForPong = false;

    if (this.#timeoutTimer !== null) {
      clearTimeout(this.#timeoutTimer);
      this.#timeoutTimer = null;
    }

    const oldStatus = this.#status;
    this.#status = 'healthy';
    if (oldStatus !== 'healthy') {
      this.#emit('healthy', { transport: this.#transport });
    }
  }

  /**
   * Register a listener for a health event.
   * Events: 'healthy', 'degraded', 'unhealthy', 'ping', 'pong-timeout'
   *
   * @param {string} event
   * @param {Function} cb
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set());
    }
    this.#listeners.get(event).add(cb);
  }

  /**
   * Remove a listener.
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const set = this.#listeners.get(event);
    if (set) set.delete(cb);
  }

  /**
   * Serialize state for inspection.
   * @returns {object}
   */
  toJSON() {
    return {
      status: this.#status,
      missedCount: this.#missedCount,
      totalPings: this.#totalPings,
      totalPongs: this.#totalPongs,
      lastPongTime: this.#lastPongTime,
    };
  }

  // -- Internal ---------------------------------------------------------------

  /** Send a ping and start a pong timeout. */
  #sendPing() {
    if (this.#waitingForPong) {
      // Previous ping still pending — count as missed
      this.#onPongTimeout();
    }

    this.#totalPings++;
    this.#waitingForPong = true;

    try {
      this.#pingFn(this.#transport);
    } catch {
      this.#onPongTimeout();
      return;
    }

    this.#emit('ping', { transport: this.#transport });
    this.#timeoutTimer = setTimeout(() => this.#onPongTimeout(), this.#timeoutMs);
  }

  /** Handle a pong timeout. */
  #onPongTimeout() {
    this.#waitingForPong = false;
    if (this.#timeoutTimer !== null) {
      clearTimeout(this.#timeoutTimer);
      this.#timeoutTimer = null;
    }

    this.#missedCount++;
    this.#emit('pong-timeout', { transport: this.#transport, missedCount: this.#missedCount });

    const oldStatus = this.#status;
    if (this.#missedCount >= this.#maxMissed) {
      this.#status = 'unhealthy';
      if (oldStatus !== 'unhealthy') {
        this.#emit('unhealthy', { transport: this.#transport, missedCount: this.#missedCount });
      }
    } else if (this.#missedCount >= 1) {
      this.#status = 'degraded';
      if (oldStatus !== 'degraded' && oldStatus !== 'unhealthy') {
        this.#emit('degraded', { transport: this.#transport, missedCount: this.#missedCount });
      }
    }
  }

  /**
   * Emit an event to all registered listeners, swallowing errors.
   * @param {string} event
   * @param {*} data
   */
  #emit(event, data) {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try { cb(data); } catch (e) { silentCatch('clawser-mesh-hardening', 'swallow', e) }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. ConnectionPool — per-peer connection pooling with idle eviction
// ---------------------------------------------------------------------------

/**
 * Manages a pool of transport connections per peer with configurable
 * limits and idle eviction.
 *
 * @example
 * const pool = new ConnectionPool({ maxPerPeer: 3, idleTimeoutMs: 60000 });
 * pool.add('peer-abc', transport);
 * const conn = pool.acquire('peer-abc');
 */
export class ConnectionPool {
  /** @type {number} */
  #maxPerPeer;

  /** @type {number} */
  #idleTimeoutMs;

  /** @type {Map<string, Array<{ transport: object, lastUsed: number, acquired: boolean }>>} */
  #pools = new Map();

  /** @type {*} */
  #evictionTimer = null;

  /** @type {number} */
  #evictionIntervalMs;

  /** @type {Function} */
  #nowFn;

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxPerPeer=3]            - Maximum connections per peer
   * @param {number} [opts.idleTimeoutMs=60000]     - Evict connections idle longer than this
   * @param {number} [opts.evictionIntervalMs=30000] - How often to run idle eviction
   * @param {Function} [opts.nowFn=Date.now]
   */
  constructor(opts = {}) {
    this.#maxPerPeer = opts.maxPerPeer ?? 3;
    this.#idleTimeoutMs = opts.idleTimeoutMs ?? 60000;
    this.#evictionIntervalMs = opts.evictionIntervalMs ?? 30000;
    this.#nowFn = opts.nowFn ?? Date.now;
  }

  /** Maximum connections allowed per peer. */
  get maxPerPeer() {
    return this.#maxPerPeer;
  }

  /** Total connections across all peers. */
  get totalConnections() {
    let count = 0;
    for (const entries of this.#pools.values()) {
      count += entries.length;
    }
    return count;
  }

  /** Number of peers with at least one connection. */
  get peerCount() {
    return this.#pools.size;
  }

  /**
   * Add a transport to the pool for a given peer.
   * If the pool for that peer is at capacity, the oldest idle connection
   * is evicted. Returns false if pool is full and no idle connections exist.
   *
   * @param {string} peerId
   * @param {object} transport
   * @returns {boolean} true if added successfully
   */
  add(peerId, transport) {
    if (!this.#pools.has(peerId)) {
      this.#pools.set(peerId, []);
    }

    const entries = this.#pools.get(peerId);

    if (entries.length >= this.#maxPerPeer) {
      // Try to evict an idle (non-acquired) entry
      const idleIdx = entries.findIndex(e => !e.acquired);
      if (idleIdx === -1) return false;

      const evicted = entries.splice(idleIdx, 1)[0];
      if (typeof evicted.transport.close === 'function') {
        try { evicted.transport.close(); } catch (e) { silentCatch('clawser-mesh-hardening', 'evicted.transport.close', e) }
      }
    }

    entries.push({
      transport,
      lastUsed: this.#nowFn(),
      acquired: false,
    });

    return true;
  }

  /**
   * Acquire an idle connection for a peer. Marks it as acquired.
   * Returns null if no idle connections exist.
   *
   * @param {string} peerId
   * @returns {object|null} The transport, or null
   */
  acquire(peerId) {
    const entries = this.#pools.get(peerId);
    if (!entries) return null;

    const entry = entries.find(e => !e.acquired);
    if (!entry) return null;

    entry.acquired = true;
    entry.lastUsed = this.#nowFn();
    return entry.transport;
  }

  /**
   * Release a previously acquired connection back to the pool.
   *
   * @param {string} peerId
   * @param {object} transport
   * @returns {boolean} true if found and released
   */
  release(peerId, transport) {
    const entries = this.#pools.get(peerId);
    if (!entries) return false;

    const entry = entries.find(e => e.transport === transport);
    if (!entry) return false;

    entry.acquired = false;
    entry.lastUsed = this.#nowFn();
    return true;
  }

  /**
   * Remove a specific transport from the pool.
   *
   * @param {string} peerId
   * @param {object} transport
   * @returns {boolean} true if found and removed
   */
  remove(peerId, transport) {
    const entries = this.#pools.get(peerId);
    if (!entries) return false;

    const idx = entries.findIndex(e => e.transport === transport);
    if (idx === -1) return false;

    entries.splice(idx, 1);
    if (entries.length === 0) {
      this.#pools.delete(peerId);
    }
    return true;
  }

  /**
   * Get count of connections for a specific peer.
   *
   * @param {string} peerId
   * @returns {number}
   */
  countFor(peerId) {
    const entries = this.#pools.get(peerId);
    return entries ? entries.length : 0;
  }

  /**
   * Get count of idle (non-acquired) connections for a peer.
   *
   * @param {string} peerId
   * @returns {number}
   */
  idleCountFor(peerId) {
    const entries = this.#pools.get(peerId);
    if (!entries) return 0;
    return entries.filter(e => !e.acquired).length;
  }

  /**
   * Start periodic idle eviction.
   */
  startEviction() {
    this.stopEviction();
    this.#evictionTimer = setInterval(() => this.evictIdle(), this.#evictionIntervalMs);
  }

  /**
   * Stop periodic idle eviction.
   */
  stopEviction() {
    if (this.#evictionTimer !== null) {
      clearInterval(this.#evictionTimer);
      this.#evictionTimer = null;
    }
  }

  /**
   * Evict all idle connections that have been unused longer than idleTimeoutMs.
   * Returns the number of evicted connections.
   *
   * @returns {number}
   */
  evictIdle() {
    const now = this.#nowFn();
    let evicted = 0;

    for (const [peerId, entries] of this.#pools) {
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!entry.acquired && (now - entry.lastUsed) > this.#idleTimeoutMs) {
          if (typeof entry.transport.close === 'function') {
            try { entry.transport.close(); } catch (e) { silentCatch('clawser-mesh-hardening', 'entry.transport.close', e) }
          }
          entries.splice(i, 1);
          evicted++;
        }
      }
      if (entries.length === 0) {
        this.#pools.delete(peerId);
      }
    }

    return evicted;
  }

  /**
   * Drain all connections, closing each transport.
   */
  drainAll() {
    for (const [, entries] of this.#pools) {
      for (const entry of entries) {
        if (typeof entry.transport.close === 'function') {
          try { entry.transport.close(); } catch (e) { silentCatch('clawser-mesh-hardening', 'entry.transport.close', e) }
        }
      }
    }
    this.#pools.clear();
    this.stopEviction();
  }

  /**
   * Serialize state for inspection.
   * @returns {object}
   */
  toJSON() {
    const pools = {};
    for (const [peerId, entries] of this.#pools) {
      pools[peerId] = entries.map(e => ({
        acquired: e.acquired,
        lastUsed: e.lastUsed,
        transportType: e.transport.type ?? 'unknown',
      }));
    }
    return {
      maxPerPeer: this.#maxPerPeer,
      idleTimeoutMs: this.#idleTimeoutMs,
      totalConnections: this.totalConnections,
      peerCount: this.peerCount,
      pools,
    };
  }
}

// ---------------------------------------------------------------------------
// 4. TransportMetrics — per-transport counters and latency tracking
// ---------------------------------------------------------------------------

/**
 * Tracks per-transport metrics: bytes sent/received, message counts,
 * error counts, and latency measurements.
 *
 * @example
 * const metrics = new TransportMetrics('wsh-ws');
 * metrics.recordSend(128);
 * metrics.recordReceive(256);
 * metrics.recordLatency(42);
 * console.log(metrics.toJSON());
 */
export class TransportMetrics {
  /** @type {string} */
  #transportId;

  /** @type {number} */
  #bytesSent = 0;

  /** @type {number} */
  #bytesReceived = 0;

  /** @type {number} */
  #messagesSent = 0;

  /** @type {number} */
  #messagesReceived = 0;

  /** @type {number} */
  #errors = 0;

  /** @type {number[]} */
  #latencySamples = [];

  /** @type {number} */
  #maxLatencySamples;

  /** @type {number} */
  #createdAt;

  /** @type {Function} */
  #nowFn;

  /**
   * @param {string} transportId - Identifier for this transport instance
   * @param {object} [opts]
   * @param {number} [opts.maxLatencySamples=100] - Rolling window size for latency
   * @param {Function} [opts.nowFn=Date.now]
   */
  constructor(transportId, opts = {}) {
    if (!transportId) throw new Error('transportId is required');
    this.#transportId = transportId;
    this.#maxLatencySamples = opts.maxLatencySamples ?? 100;
    this.#nowFn = opts.nowFn ?? Date.now;
    this.#createdAt = this.#nowFn();
  }

  /** Transport identifier. */
  get transportId() {
    return this.#transportId;
  }

  /** Total bytes sent. */
  get bytesSent() {
    return this.#bytesSent;
  }

  /** Total bytes received. */
  get bytesReceived() {
    return this.#bytesReceived;
  }

  /** Total messages sent. */
  get messagesSent() {
    return this.#messagesSent;
  }

  /** Total messages received. */
  get messagesReceived() {
    return this.#messagesReceived;
  }

  /** Total error count. */
  get errors() {
    return this.#errors;
  }

  /**
   * Record a send operation.
   * @param {number} bytes - Byte length of the message
   */
  recordSend(bytes) {
    this.#messagesSent++;
    this.#bytesSent += bytes;
  }

  /**
   * Record a receive operation.
   * @param {number} bytes - Byte length of the message
   */
  recordReceive(bytes) {
    this.#messagesReceived++;
    this.#bytesReceived += bytes;
  }

  /**
   * Record an error.
   */
  recordError() {
    this.#errors++;
  }

  /**
   * Record a latency sample.
   * @param {number} ms - Latency in milliseconds
   */
  recordLatency(ms) {
    this.#latencySamples.push(ms);
    if (this.#latencySamples.length > this.#maxLatencySamples) {
      this.#latencySamples.shift();
    }
  }

  /**
   * Get latency statistics from the rolling window.
   * @returns {{ min: number, max: number, avg: number, p50: number, p95: number, p99: number, count: number }}
   */
  getLatencyStats() {
    const samples = this.#latencySamples;
    if (samples.length === 0) {
      return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0, count: 0 };
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: Math.round(sum / sorted.length),
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      count: sorted.length,
    };
  }

  /**
   * Reset all counters to zero.
   */
  reset() {
    this.#bytesSent = 0;
    this.#bytesReceived = 0;
    this.#messagesSent = 0;
    this.#messagesReceived = 0;
    this.#errors = 0;
    this.#latencySamples = [];
  }

  /**
   * Serialize all metrics.
   * @returns {object}
   */
  toJSON() {
    return {
      transportId: this.#transportId,
      bytesSent: this.#bytesSent,
      bytesReceived: this.#bytesReceived,
      messagesSent: this.#messagesSent,
      messagesReceived: this.#messagesReceived,
      errors: this.#errors,
      latency: this.getLatencyStats(),
      uptimeMs: this.#nowFn() - this.#createdAt,
    };
  }
}

/**
 * Registry that manages TransportMetrics instances keyed by transport ID.
 *
 * @example
 * const registry = new MetricsRegistry();
 * registry.getOrCreate('ws-peer-abc').recordSend(128);
 */
export class MetricsRegistry {
  /** @type {Map<string, TransportMetrics>} */
  #metrics = new Map();

  /**
   * Get or create metrics for a transport ID.
   * @param {string} transportId
   * @returns {TransportMetrics}
   */
  getOrCreate(transportId) {
    if (!this.#metrics.has(transportId)) {
      this.#metrics.set(transportId, new TransportMetrics(transportId));
    }
    return this.#metrics.get(transportId);
  }

  /**
   * Get metrics for a transport ID, or null if not tracked.
   * @param {string} transportId
   * @returns {TransportMetrics|null}
   */
  get(transportId) {
    return this.#metrics.get(transportId) ?? null;
  }

  /**
   * Remove metrics for a transport.
   * @param {string} transportId
   * @returns {boolean}
   */
  remove(transportId) {
    return this.#metrics.delete(transportId);
  }

  /** Number of tracked transports. */
  get size() {
    return this.#metrics.size;
  }

  /**
   * Serialize all metrics.
   * @returns {object}
   */
  toJSON() {
    const result = {};
    for (const [id, m] of this.#metrics) {
      result[id] = m.toJSON();
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// 5. TransportFailover — graceful degradation across transport types
// ---------------------------------------------------------------------------

/**
 * Wraps a MeshTransportNegotiator to provide transparent failover
 * when the active transport becomes unhealthy. Monitors the active
 * transport and automatically falls back to the next available type.
 *
 * @example
 * const failover = new TransportFailover({
 *   negotiator,
 *   endpoints: { webrtc: 'rtc://p', 'wsh-ws': 'ws://p' },
 *   healthCheckOpts: { intervalMs: 5000 },
 * });
 * const transport = await failover.connect();
 */
export class TransportFailover {
  /** @type {object} */
  #negotiator;

  /** @type {object} */
  #endpoints;

  /** @type {object} */
  #auth;

  /** @type {object} */
  #activeTransport = null;

  /** @type {string[]} */
  #failedTypes = [];

  /** @type {boolean} */
  #failingOver = false;

  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();

  /** @type {RetryWithBackoff|null} */
  #retry;

  /**
   * @param {object} opts
   * @param {object} opts.negotiator   - MeshTransportNegotiator instance
   * @param {object} opts.endpoints    - Map of type -> endpoint string
   * @param {object} [opts.auth]       - Auth credentials
   * @param {RetryWithBackoff} [opts.retry] - Retry instance for connection attempts
   */
  constructor(opts) {
    if (!opts.negotiator) throw new Error('negotiator is required');
    if (!opts.endpoints) throw new Error('endpoints is required');
    this.#negotiator = opts.negotiator;
    this.#endpoints = { ...opts.endpoints };
    this.#auth = opts.auth ?? null;
    this.#retry = opts.retry ?? null;
  }

  /** Currently active transport, or null. */
  get activeTransport() {
    return this.#activeTransport;
  }

  /** Transport types that have failed and been excluded. */
  get failedTypes() {
    return [...this.#failedTypes];
  }

  /** Whether a failover is currently in progress. */
  get failingOver() {
    return this.#failingOver;
  }

  /**
   * Establish an initial connection using the negotiator.
   *
   * @returns {Promise<object>} The connected transport
   */
  async connect() {
    const negotiate = () => this.#negotiator.negotiate(this.#endpoints, this.#auth);
    const transport = this.#retry
      ? await this.#retry.execute(negotiate)
      : await negotiate();

    this.#activeTransport = transport;
    this.#emit('connected', { transport });
    return transport;
  }

  /**
   * Trigger a failover: mark the current transport type as failed,
   * close it, and negotiate a new connection excluding failed types.
   *
   * @param {string} [reason='unknown'] - Reason for failover
   * @returns {Promise<object>} The new transport
   * @throws {Error} If no transports are available
   */
  async failover(reason = 'unknown') {
    if (this.#failingOver) {
      throw new Error('Failover already in progress');
    }

    this.#failingOver = true;
    this.#emit('failover-start', { reason, previousType: this.#activeTransport?.type });

    try {
      // Mark current transport type as failed
      if (this.#activeTransport) {
        const failedType = this.#activeTransport.type;
        if (!this.#failedTypes.includes(failedType)) {
          this.#failedTypes.push(failedType);
        }
        // Close the old transport
        if (typeof this.#activeTransport.close === 'function') {
          try { this.#activeTransport.close(); } catch (e) { silentCatch('clawser-mesh-hardening', 'this', e) }
        }
        this.#activeTransport = null;
      }

      // Build filtered endpoints excluding failed types
      const filteredEndpoints = {};
      for (const [type, ep] of Object.entries(this.#endpoints)) {
        if (!this.#failedTypes.includes(type)) {
          filteredEndpoints[type] = ep;
        }
      }

      if (Object.keys(filteredEndpoints).length === 0) {
        throw new Error(`No transports available (all failed: ${this.#failedTypes.join(', ')})`);
      }

      const negotiate = () => this.#negotiator.negotiate(filteredEndpoints, this.#auth);
      const transport = this.#retry
        ? await this.#retry.execute(negotiate)
        : await negotiate();

      this.#activeTransport = transport;
      this.#emit('failover-complete', { transport, reason });
      return transport;
    } catch (err) {
      this.#emit('failover-failed', { reason, error: err.message });
      throw err;
    } finally {
      this.#failingOver = false;
    }
  }

  /**
   * Reset the list of failed transport types, allowing them to be
   * retried on the next failover.
   */
  resetFailedTypes() {
    this.#failedTypes = [];
  }

  /**
   * Register a listener for a failover event.
   * Events: 'connected', 'failover-start', 'failover-complete', 'failover-failed'
   *
   * @param {string} event
   * @param {Function} cb
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set());
    }
    this.#listeners.get(event).add(cb);
  }

  /**
   * Remove a listener.
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const set = this.#listeners.get(event);
    if (set) set.delete(cb);
  }

  /**
   * Serialize state for inspection.
   * @returns {object}
   */
  toJSON() {
    return {
      activeTransportType: this.#activeTransport?.type ?? null,
      failedTypes: [...this.#failedTypes],
      failingOver: this.#failingOver,
    };
  }

  // -- Internal ---------------------------------------------------------------

  /**
   * Emit an event to all registered listeners, swallowing errors.
   * @param {string} event
   * @param {*} data
   */
  #emit(event, data) {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try { cb(data); } catch (e) { silentCatch('clawser-mesh-hardening', 'swallow', e) }
    }
  }
}
