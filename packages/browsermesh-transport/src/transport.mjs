/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-transport.js -- Transport Abstraction Layer.
 *
 * Unified interface for mesh connections across transport types.
 * Actual transport creation is pluggable via adapter factories passed
 * to MeshTransportNegotiator. This keeps the core logic testable
 * without real WebRTC/WebSocket/WebTransport connections.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-transport.test.mjs
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @type {readonly string[]} */
const TRANSPORT_TYPES = Object.freeze(['webrtc', 'wsh-wt', 'wsh-ws']);

/** @type {readonly string[]} */
const TRANSPORT_STATES = Object.freeze([
  'disconnected',
  'connecting',
  'connected',
  'closing',
  'closed',
]);

// ---------------------------------------------------------------------------
// MeshTransport (abstract base)
// ---------------------------------------------------------------------------

/**
 * Abstract transport interface.
 * All mesh transports must extend this and implement connect() and send().
 */
export class MeshTransport {
  /** @type {string} */
  #type;

  /** @type {string} */
  #state = 'disconnected';

  /** @type {number} */
  #latency = 0;

  /** @type {{ stream: Function[], close: Function[], error: Function[], message: Function[] }} */
  #callbacks = { stream: [], close: [], error: [], message: [] };

  /**
   * @param {string} type - One of TRANSPORT_TYPES
   */
  constructor(type) {
    if (!TRANSPORT_TYPES.includes(type)) {
      throw new Error(`Unknown transport type: ${type}`);
    }
    this.#type = type;
  }

  /** Transport type identifier. */
  get type() {
    return this.#type;
  }

  /** Current connection state. */
  get state() {
    return this.#state;
  }

  /** True when transport is in 'connected' state. */
  get connected() {
    return this.#state === 'connected';
  }

  /** Last measured latency in ms. */
  get latency() {
    return this.#latency;
  }

  /**
   * Transition to a new state. Fires 'close' when entering 'closed'.
   * @protected
   * @param {string} state
   */
  _setState(state) {
    this.#state = state;
    if (state === 'closed') {
      this._fire('close');
    }
  }

  /**
   * Update the latency measurement.
   * @protected
   * @param {number} ms
   */
  _setLatency(ms) {
    this.#latency = ms;
  }

  /**
   * Connect to a peer endpoint. Must be overridden by subclass.
   *
   * @param {string} endpoint
   * @param {object} [auth]
   * @returns {Promise<void>}
   */
  async connect(endpoint, auth) {
    throw new Error('connect() must be implemented by subclass');
  }

  /**
   * Close the transport gracefully.
   */
  close() {
    this._setState('closing');
    this._setState('closed');
  }

  /**
   * Send a message over the transport. Must be overridden by subclass.
   *
   * @param {*} data
   */
  send(data) {
    throw new Error('send() must be implemented by subclass');
  }

  // -- Event registration -------------------------------------------------

  /**
   * Register callback for incoming byte streams.
   * @param {Function} cb
   */
  onStream(cb) {
    this.#callbacks.stream.push(cb);
  }

  /**
   * Register callback for transport close.
   * @param {Function} cb
   */
  onClose(cb) {
    this.#callbacks.close.push(cb);
  }

  /**
   * Register callback for transport errors.
   * @param {Function} cb
   */
  onError(cb) {
    this.#callbacks.error.push(cb);
  }

  /**
   * Register callback for incoming messages.
   * @param {Function} cb
   */
  onMessage(cb) {
    this.#callbacks.message.push(cb);
  }

  /**
   * Fire all callbacks for a given event, swallowing listener errors.
   * @protected
   * @param {string} event
   * @param {*} [data]
   */
  _fire(event, data) {
    for (const cb of this.#callbacks[event] || []) {
      try {
        cb(data);
      } catch {
        /* listener errors do not propagate */
      }
    }
  }

  /**
   * Serialize to a JSON-safe object (no callbacks/handles).
   * @returns {object}
   */
  toJSON() {
    return {
      type: this.#type,
      state: this.#state,
      latency: this.#latency,
    };
  }
}

// ---------------------------------------------------------------------------
// MockMeshTransport
// ---------------------------------------------------------------------------

/**
 * In-memory mock transport for testing and local peer simulation.
 * Supports pairing two instances for bidirectional message delivery.
 */
export class MockMeshTransport extends MeshTransport {
  /** @type {Array} */
  #messages = [];

  /** @type {MockMeshTransport|null} */
  #partner = null;

  /**
   * @param {string} [type='wsh-ws'] - Transport type to emulate
   */
  constructor(type = 'wsh-ws') {
    super(type);
  }

  /**
   * Simulate a connection handshake.
   *
   * @param {string} _endpoint
   * @param {object} [_auth]
   * @returns {Promise<void>}
   */
  async connect(_endpoint, _auth) {
    this._setState('connecting');
    this._setState('connected');
    this._setLatency(1);
  }

  /**
   * Send data. Throws if not connected. If paired, delivers to partner.
   *
   * @param {*} data
   */
  send(data) {
    if (!this.connected) {
      throw new Error('Transport not connected');
    }
    this.#messages.push(data);
    if (this.#partner) {
      this.#partner._fire('message', data);
    }
  }

  /**
   * Link two mock transports for bidirectional communication.
   *
   * @param {MockMeshTransport} other
   */
  pair(other) {
    this.#partner = other;
    other.#partner = this;
  }

  /**
   * Messages sent through this transport instance.
   * @returns {Array}
   */
  get sentMessages() {
    return [...this.#messages];
  }

  /**
   * Close transport and detach partner.
   */
  close() {
    this.#partner = null;
    super.close();
  }
}

// ---------------------------------------------------------------------------
// MeshTransportNegotiator
// ---------------------------------------------------------------------------

/**
 * Tries transport adapters in preference order and returns the first
 * that successfully connects. Adapters are registered as async factory
 * functions that produce a connected MeshTransport.
 */
export class MeshTransportNegotiator {
  /** @type {Map<string, Function>} type -> async factory(endpoint, auth) => MeshTransport */
  #adapters = new Map();

  /** @type {string[]} */
  #preferenceOrder = ['webrtc', 'wsh-wt', 'wsh-ws'];

  /**
   * @param {object} [opts]
   * @param {string[]} [opts.preferenceOrder] - Override default preference
   */
  constructor(opts = {}) {
    if (opts.preferenceOrder) {
      this.#preferenceOrder = [...opts.preferenceOrder];
    }
  }

  /**
   * Register a transport adapter factory.
   *
   * The factory signature is: `(endpoint, auth) => Promise<MeshTransport>`
   *
   * @param {string} type - One of TRANSPORT_TYPES
   * @param {Function} factory
   */
  registerAdapter(type, factory) {
    if (!TRANSPORT_TYPES.includes(type)) {
      throw new Error(`Unknown transport type: ${type}`);
    }
    this.#adapters.set(type, factory);
  }

  /**
   * Negotiate the best transport for a peer.
   *
   * Tries each type in preference order. Returns the first successfully
   * created transport. Throws if all fail.
   *
   * @param {object} endpoints - Map of type -> endpoint string
   * @param {object} [auth]    - Auth credentials to pass to adapters
   * @returns {Promise<MeshTransport>}
   */
  async negotiate(endpoints, auth) {
    const errors = [];
    for (const type of this.#preferenceOrder) {
      const factory = this.#adapters.get(type);
      if (!factory) continue;
      const endpoint = endpoints[type];
      if (!endpoint) continue;
      try {
        const transport = await factory(endpoint, auth);
        return transport;
      } catch (e) {
        errors.push({ type, error: e.message });
      }
    }
    throw new Error(`All transports failed: ${JSON.stringify(errors)}`);
  }

  /**
   * List transport types that have a registered adapter.
   *
   * @returns {string[]}
   */
  availableTypes() {
    return [...this.#adapters.keys()];
  }

  /**
   * Current preference order (copy).
   *
   * @returns {string[]}
   */
  get preferenceOrder() {
    return [...this.#preferenceOrder];
  }
}

export { TRANSPORT_TYPES, TRANSPORT_STATES };
