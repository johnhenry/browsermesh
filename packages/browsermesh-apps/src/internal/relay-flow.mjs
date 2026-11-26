/**
 * relay-flow.mjs -- byte credits for relayed connections.
 *
 * Each side of a relayed connection tells the other, when the connection is
 * set up, how many bytes it is willing to have outstanding toward it (its
 * window). The sender may have at most that many bytes sent and not yet
 * credited. The receiver returns credit as it consumes bytes. A sender that
 * has used its whole window stops reading from its local socket until the
 * credit it holds is back above `window - lowWater` (pause at the high-water
 * mark, resume under the low-water mark). Nothing is dropped; a peer that
 * exceeds a bound has its connection closed with a reason.
 *
 * A peer that does not advertise a window (an older version) is not sent
 * credit frames and cannot be paused; only the buffer bounds apply to it.
 *
 * No browser-only imports at module level.
 */

/** Defaults for relayed-connection flow control. All are options of `MeshRelayHost` / `createMeshRelayBackend`. */
export const RELAY_FLOW_DEFAULTS = Object.freeze({
  /** Receive window per connection: bytes a peer may have outstanding toward us; pause point. */
  highWaterBytes: 256 * 1024,
  /** A paused sender resumes once its outstanding bytes are at or below this. */
  lowWaterBytes: 64 * 1024,
  /** Hard cap on bytes received and not yet consumed, per connection. */
  maxBufferedBytesPerConnection: 1024 * 1024,
  /** Hard cap on the same, summed over one peer's connections (host side). */
  maxBufferedBytesPerPeer: 4 * 1024 * 1024,
  /** Most connections (open or being opened) one peer may hold (host side). */
  maxConnectionsPerPeer: 16,
  /** Largest data frame we send, in bytes before base64. */
  maxFrameBytes: 64 * 1024,
  /** How often the host re-checks access of open connections, ms. 0 disables. */
  recheckIntervalMs: 30_000,
  /**
   * A connection that is half-closed (one side has said it will send no more, the other has not) stays open while
   * anything moves in either direction, and is closed (reason `idle timeout`) after this many ms with nothing moving.
   * 0 = never. Only connections where both peers negotiated half-close are ever half-closed.
   */
  halfCloseIdleMs: 300_000,
})

/**
 * Merge options over the defaults and validate them.
 * @param {object} [opts]
 * @returns {typeof RELAY_FLOW_DEFAULTS}
 */
export function resolveFlowOptions(opts = {}) {
  const out = { ...RELAY_FLOW_DEFAULTS }
  for (const key of Object.keys(out)) {
    if (opts[key] === undefined) continue
    const v = opts[key]
    const min = key === 'recheckIntervalMs' || key === 'halfCloseIdleMs' ? 0 : 1
    if (!Number.isInteger(v) || v < min) throw new Error(`${key} must be an integer >= ${min}`)
    if (key === 'halfCloseIdleMs' && v > 0x7fffffff) throw new Error(`${key} must be at most 2147483647 (a timer cannot wait longer)`)
    out[key] = v
  }
  if (out.lowWaterBytes >= out.highWaterBytes) throw new Error('lowWaterBytes must be below highWaterBytes')
  if (out.highWaterBytes > out.maxBufferedBytesPerConnection) {
    throw new Error('highWaterBytes must not exceed maxBufferedBytesPerConnection')
  }
  return Object.freeze(out)
}

/** The sending side of one direction of one connection. */
export class CreditSender {
  #window
  #lowWater
  #inFlight = 0
  #paused = false
  #closed = false
  #waiters = []

  /** @param {{ window: number, lowWater: number }} opts - `window` 0 or missing: no flow control */
  constructor({ window, lowWater }) {
    this.#window = Number.isInteger(window) && window > 0 ? window : 0
    this.#lowWater = Math.min(lowWater, Math.max(0, this.#window - 1))
  }

  get enabled() { return this.#window > 0 }
  get inFlight() { return this.#inFlight }
  get paused() { return this.#paused }

  /**
   * Wait until some bytes may be sent and reserve them.
   * @param {number} want
   * @returns {Promise<number>} bytes reserved (1..want), or 0 if closed
   */
  async reserve(want) {
    if (!this.enabled) return this.#closed ? 0 : want
    for (;;) {
      if (this.#closed) return 0
      if (!this.#paused) {
        const n = Math.min(want, this.#window - this.#inFlight)
        if (n > 0) {
          this.#inFlight += n
          if (this.#inFlight >= this.#window) this.#paused = true
          return n
        }
        this.#paused = true
      }
      await new Promise((resolve) => this.#waiters.push(resolve))
    }
  }

  /**
   * Credit returned by the peer.
   * @param {number} n
   * @returns {boolean} false if the credit is invalid (more than is in flight)
   */
  credit(n) {
    if (!Number.isInteger(n) || n <= 0 || n > this.#inFlight) return false
    this.#inFlight -= n
    if (this.#paused && this.#inFlight <= this.#lowWater) {
      this.#paused = false
      this.#wake()
    }
    return true
  }

  close() {
    this.#closed = true
    this.#wake()
  }

  #wake() {
    const waiters = this.#waiters.splice(0)
    for (const w of waiters) w()
  }
}

/** The receiving side of one direction of one connection. */
export class CreditReceiver {
  #window
  #lowWater
  #maxBuffered
  #creditAware
  #grant
  #outstanding = 0
  #pending = 0

  /**
   * @param {object} opts
   * @param {number} opts.window - the window we advertised
   * @param {number} opts.lowWater
   * @param {number} opts.maxBuffered - hard cap on unconsumed bytes
   * @param {boolean} opts.creditAware - the peer honours credit (it advertised a window or answered with one)
   * @param {(bytes: number) => void} opts.grant - send a credit frame
   */
  constructor({ window, lowWater, maxBuffered, creditAware, grant }) {
    this.#window = window
    this.#lowWater = lowWater
    this.#maxBuffered = maxBuffered
    this.#creditAware = creditAware
    this.#grant = grant
  }

  /** Bytes received and not yet consumed. */
  get outstanding() { return this.#outstanding }
  get creditAware() { return this.#creditAware }

  /**
   * Account for `n` bytes that arrived.
   * @param {number} n
   * @returns {'ok'|'violation'|'overflow'} violation: a credit-aware peer went over its window
   */
  receive(n) {
    if (this.#creditAware && this.#outstanding + this.#pending + n > this.#window) return 'violation'
    if (this.#outstanding + n > this.#maxBuffered) return 'overflow'
    this.#outstanding += n
    return 'ok'
  }

  /** `n` bytes have been handed on; return credit in batches. */
  consumed(n) {
    this.#outstanding -= n
    if (!this.#creditAware) return
    this.#pending += n
    if (this.#pending >= this.#window - this.#lowWater) {
      const give = this.#pending
      this.#pending = 0
      this.#grant(give)
    }
  }
}
