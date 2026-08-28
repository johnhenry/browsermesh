/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * Clawser Mesh Streams
 *
 * Multiplexed data streaming with credit-based backpressure.
 * Wraps BrowserMesh streaming-protocol.md spec (0x12-0x16 wire codes)
 * with a higher-level application API.
 *
 * @module clawser-mesh-streams
 */

import { MESH_TYPE, MESH_ERROR } from '@johnhenry/browsermesh-primitives';

// ── Constants ────────────────────────────────────────────────────────

export const STREAM_STATES = Object.freeze([
  'IDLE', 'OPEN', 'HALF_CLOSED_LOCAL', 'HALF_CLOSED_REMOTE', 'CLOSED',
]);

export const STREAM_ERROR_CODES = Object.freeze([
  'CANCELLED', 'TIMEOUT', 'FLOW_CONTROL', 'TOO_LARGE', 'INTERNAL',
]);

export const STREAM_DEFAULTS = Object.freeze({
  initialCredits: 8,
  maxCredits: 64,
  idleTimeout: 30_000,
  maxStreamSize: 256 * 1024 * 1024,
  maxConcurrentStreams: 16,
  maxChunkSize: 16_384,
});

// ── Helpers ──────────────────────────────────────────────────────────

let _idCounter = 0;

function generateStreamId() {
  // 16-byte ID: 8 random + 4 timestamp + 4 counter
  const id = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(id);
  } else {
    for (let i = 0; i < 16; i++) id[i] = (Math.random() * 256) | 0;
  }
  const view = new DataView(id.buffer);
  view.setUint32(12, ++_idCounter, false);
  return id;
}

function streamIdToHex(id) {
  if (typeof id === 'string') return id;
  return Array.from(id).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Valid state transitions: { fromState: [toState, ...] }
const VALID_TRANSITIONS = {
  IDLE: ['OPEN', 'CLOSED'],
  OPEN: ['HALF_CLOSED_LOCAL', 'HALF_CLOSED_REMOTE', 'CLOSED'],
  HALF_CLOSED_LOCAL: ['CLOSED'],
  HALF_CLOSED_REMOTE: ['CLOSED'],
  CLOSED: [],
};

// ── MeshStream ───────────────────────────────────────────────────────

/**
 * A single multiplexed stream with state machine, flow control,
 * and callback-based data delivery.
 */
export class MeshStream {
  #id;
  #hexId;
  #state = 'IDLE';
  #method;
  #ordered;
  #encrypted;
  #metadata;
  #initiator;
  #sendSeq = 0;
  #recvSeq = 0;
  #sendCredits;
  #recvCredits;
  #bytesSent = 0;
  #bytesReceived = 0;
  #framesSent = 0;
  #framesReceived = 0;
  #createdAt;
  #closedAt = null;
  #maxSize;

  // Callbacks
  #onData = null;
  #onEnd = null;
  #onError = null;
  #onCredits = null;

  // Send queue + credit wait
  #sendQueue = [];
  #creditResolvers = [];

  // Multiplexer back-reference for sending
  #mux = null;

  constructor(opts = {}) {
    this.#id = opts.id || generateStreamId();
    this.#hexId = streamIdToHex(this.#id);
    this.#method = opts.method || '';
    this.#ordered = opts.ordered !== false;
    this.#encrypted = opts.encrypted === true;
    this.#metadata = opts.metadata || {};
    this.#initiator = opts.initiator === true;
    this.#sendCredits = opts.initialCredits ?? STREAM_DEFAULTS.initialCredits;
    this.#recvCredits = opts.initialCredits ?? STREAM_DEFAULTS.initialCredits;
    this.#maxSize = opts.maxSize ?? STREAM_DEFAULTS.maxStreamSize;
    this.#createdAt = opts.createdAt ?? Date.now();
    this.#mux = opts.multiplexer || null;
  }

  // ── Accessors ────────────────────────────────────────────────────

  get id() { return this.#id; }
  get hexId() { return this.#hexId; }
  get state() { return this.#state; }
  get method() { return this.#method; }
  get ordered() { return this.#ordered; }
  get encrypted() { return this.#encrypted; }
  get metadata() { return this.#metadata; }
  get initiator() { return this.#initiator; }
  get sendCredits() { return this.#sendCredits; }
  get recvCredits() { return this.#recvCredits; }
  get sendSeq() { return this.#sendSeq; }
  get recvSeq() { return this.#recvSeq; }

  // ── Callbacks ────────────────────────────────────────────────────

  onData(cb) { this.#onData = cb; return this; }
  onEnd(cb) { this.#onEnd = cb; return this; }
  onError(cb) { this.#onError = cb; return this; }
  onCredits(cb) { this.#onCredits = cb; return this; }

  // ── State transitions ────────────────────────────────────────────

  /** @internal Transition state with validation */
  _transition(newState) {
    const allowed = VALID_TRANSITIONS[this.#state];
    if (!allowed || !allowed.includes(newState)) {
      throw new Error(
        `Invalid stream state transition: ${this.#state} → ${newState}`
      );
    }
    this.#state = newState;
    if (newState === 'CLOSED') {
      this.#closedAt = Date.now();
    }
  }

  /** @internal Set state to OPEN (from IDLE) */
  _open() {
    this._transition('OPEN');
  }

  // ── Writing ──────────────────────────────────────────────────────

  /**
   * Write data to the stream. Respects credit-based flow control.
   * @param {Uint8Array|string} data
   * @returns {boolean} true if written immediately, false if queued
   */
  write(data) {
    if (this.#state !== 'OPEN' && this.#state !== 'HALF_CLOSED_REMOTE') {
      throw new Error(`Cannot write in state ${this.#state}`);
    }
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (this.#bytesSent + bytes.length > this.#maxSize) {
      throw new Error(`Stream size limit exceeded (max ${this.#maxSize})`);
    }
    if (this.#sendCredits > 0) {
      this.#sendCredits--;
      this.#sendSeq++;
      this.#bytesSent += bytes.length;
      this.#framesSent++;
      if (this.#mux) {
        this.#mux._sendData(this.#hexId, bytes, this.#sendSeq);
      }
      return true;
    }
    // Queue for when credits arrive
    this.#sendQueue.push(bytes);
    return false;
  }

  /**
   * Close the local side of the stream (half-close).
   */
  end() {
    if (this.#state === 'CLOSED' || this.#state === 'HALF_CLOSED_LOCAL') return;
    if (this.#state === 'HALF_CLOSED_REMOTE') {
      this._transition('CLOSED');
    } else if (this.#state === 'OPEN') {
      this._transition('HALF_CLOSED_LOCAL');
    } else {
      // IDLE — just close
      this._transition('CLOSED');
    }
    if (this.#mux) {
      this.#mux._sendEnd(this.#hexId, this.#bytesSent);
    }
  }

  /**
   * Cancel the stream with an optional reason.
   * @param {string} [reason]
   */
  cancel(reason) {
    if (this.#state === 'CLOSED') return;
    const prevState = this.#state;
    this.#state = 'CLOSED';
    this.#closedAt = Date.now();
    this.#sendQueue.length = 0;
    // Reject pending credit waiters
    for (const r of this.#creditResolvers) {
      r.reject(new Error('Stream cancelled'));
    }
    this.#creditResolvers.length = 0;
    if (this.#mux && prevState !== 'IDLE') {
      this.#mux._sendError(this.#hexId, 'CANCELLED', reason || 'Stream cancelled');
    }
  }

  // ── Flow control ─────────────────────────────────────────────────

  /**
   * Grant additional credits to the remote sender.
   * @param {number} n - Number of credits to grant
   */
  grantCredits(n) {
    if (n <= 0 || !Number.isFinite(n)) throw new Error('Credits must be positive');
    if (this.#state === 'CLOSED') return;
    const newCredits = this.#recvCredits + n;
    if (newCredits > STREAM_DEFAULTS.maxCredits) {
      throw new Error(`Credits would exceed max (${STREAM_DEFAULTS.maxCredits})`);
    }
    this.#recvCredits = newCredits;
    if (this.#mux) {
      this.#mux._sendWindowUpdate(this.#hexId, n);
    }
  }

  /**
   * @internal Receive credits from remote side (window update).
   * @param {number} n
   */
  _receiveCredits(n) {
    this.#sendCredits += n;
    if (this.#sendCredits > STREAM_DEFAULTS.maxCredits) {
      this.#sendCredits = STREAM_DEFAULTS.maxCredits;
    }
    if (this.#onCredits) this.#onCredits(this.#sendCredits);
    // Drain queued writes
    while (this.#sendQueue.length > 0 && this.#sendCredits > 0) {
      const bytes = this.#sendQueue.shift();
      this.#sendCredits--;
      this.#sendSeq++;
      this.#bytesSent += bytes.length;
      this.#framesSent++;
      if (this.#mux) {
        this.#mux._sendData(this.#hexId, bytes, this.#sendSeq);
      }
    }
  }

  // ── Receive path (called by multiplexer) ─────────────────────────

  /** @internal Handle inbound data frame */
  _receiveData(data, seq) {
    if (this.#state !== 'OPEN' && this.#state !== 'HALF_CLOSED_LOCAL') {
      return; // Drop data in wrong state
    }
    this.#recvSeq = seq;
    this.#bytesReceived += data.length;
    this.#framesReceived++;
    if (this.#onData) this.#onData(data, seq);
  }

  /** @internal Handle inbound end */
  _receiveEnd() {
    if (this.#state === 'CLOSED') return;
    if (this.#state === 'HALF_CLOSED_LOCAL') {
      this._transition('CLOSED');
    } else if (this.#state === 'OPEN') {
      this._transition('HALF_CLOSED_REMOTE');
    } else {
      this.#state = 'CLOSED';
      this.#closedAt = Date.now();
    }
    if (this.#onEnd) this.#onEnd();
  }

  /** @internal Handle inbound error */
  _receiveError(code, message) {
    if (this.#state === 'CLOSED') return;
    this.#state = 'CLOSED';
    this.#closedAt = Date.now();
    this.#sendQueue.length = 0;
    for (const r of this.#creditResolvers) {
      r.reject(new Error(message));
    }
    this.#creditResolvers.length = 0;
    if (this.#onError) this.#onError({ code, message });
  }

  // ── Stats ────────────────────────────────────────────────────────

  getStats() {
    return {
      bytesSent: this.#bytesSent,
      bytesReceived: this.#bytesReceived,
      framesSent: this.#framesSent,
      framesReceived: this.#framesReceived,
      duration: (this.#closedAt || Date.now()) - this.#createdAt,
    };
  }

  // ── Serialization ────────────────────────────────────────────────

  toJSON() {
    return {
      id: this.#hexId,
      state: this.#state,
      method: this.#method,
      ordered: this.#ordered,
      encrypted: this.#encrypted,
      metadata: this.#metadata,
      initiator: this.#initiator,
      sendSeq: this.#sendSeq,
      recvSeq: this.#recvSeq,
      sendCredits: this.#sendCredits,
      recvCredits: this.#recvCredits,
      bytesSent: this.#bytesSent,
      bytesReceived: this.#bytesReceived,
      framesSent: this.#framesSent,
      framesReceived: this.#framesReceived,
      createdAt: this.#createdAt,
      closedAt: this.#closedAt,
    };
  }

  static fromJSON(json, multiplexer = null) {
    // Reconstruct hex ID as Uint8Array
    const idBytes = new Uint8Array(json.id.match(/.{2}/g).map(h => parseInt(h, 16)));
    const stream = new MeshStream({
      id: idBytes,
      method: json.method,
      ordered: json.ordered,
      encrypted: json.encrypted,
      metadata: json.metadata,
      initiator: json.initiator,
      initialCredits: 0, // set manually below
      maxSize: STREAM_DEFAULTS.maxStreamSize,
      createdAt: json.createdAt,
      multiplexer,
    });
    // Restore internal state
    stream.#state = json.state;
    stream.#sendSeq = json.sendSeq;
    stream.#recvSeq = json.recvSeq;
    stream.#sendCredits = json.sendCredits;
    stream.#recvCredits = json.recvCredits;
    stream.#bytesSent = json.bytesSent;
    stream.#bytesReceived = json.bytesReceived;
    stream.#framesSent = json.framesSent;
    stream.#framesReceived = json.framesReceived;
    stream.#closedAt = json.closedAt;
    return stream;
  }
}

// ── StreamMultiplexer ────────────────────────────────────────────────

/**
 * Multi-stream manager. Routes inbound messages to the correct stream,
 * enforces concurrency limits, and exposes an API for opening/closing streams.
 */
export class StreamMultiplexer {
  /** @type {Map<string, MeshStream>} hexId → stream */
  #streams = new Map();
  #maxConcurrent;
  #defaults;

  // Callbacks
  #onStream = null;
  #onSend = null;

  constructor(opts = {}) {
    this.#maxConcurrent = opts.maxConcurrentStreams ?? STREAM_DEFAULTS.maxConcurrentStreams;
    this.#defaults = { ...STREAM_DEFAULTS, ...opts };
  }

  // ── Callbacks ────────────────────────────────────────────────────

  /**
   * Register callback for inbound streams opened by the remote side.
   * @param {(stream: MeshStream) => void} cb
   */
  onStream(cb) { this.#onStream = cb; return this; }

  /**
   * Register callback for outbound messages that need to be sent over the wire.
   * @param {(msg: object) => void} cb
   */
  onSend(cb) { this.#onSend = cb; return this; }

  // ── Open / Close ─────────────────────────────────────────────────

  /**
   * Open a new outgoing stream.
   * @param {string} method - Stream purpose (e.g. 'storage/upload')
   * @param {object} [opts]
   * @returns {MeshStream}
   */
  open(method, opts = {}) {
    const active = this.activeCount;
    if (active >= this.#maxConcurrent) {
      throw new Error(
        `Concurrent stream limit reached (${active}/${this.#maxConcurrent})`
      );
    }

    const stream = new MeshStream({
      method,
      ordered: opts.ordered,
      encrypted: opts.encrypted,
      metadata: opts.metadata,
      initiator: true,
      initialCredits: opts.initialCredits ?? this.#defaults.initialCredits,
      maxSize: opts.maxSize ?? this.#defaults.maxStreamSize,
      multiplexer: this,
    });

    stream._open();
    this.#streams.set(stream.hexId, stream);

    // Send STREAM_OPEN to remote
    this._emit({
      t: MESH_TYPE.STREAM_OPEN,
      p: {
        streamId: stream.hexId,
        method,
        ordered: stream.ordered,
        encrypted: stream.encrypted,
        initialCredits: stream.sendCredits,
        metadata: stream.metadata,
      },
    });

    return stream;
  }

  /**
   * Close a stream by ID.
   * @param {string} streamId - hex stream ID
   */
  close(streamId) {
    const stream = this.#streams.get(streamId);
    if (!stream) return;
    stream.end();
    if (stream.state === 'CLOSED') {
      this.#streams.delete(streamId);
    }
  }

  /**
   * Close all active streams.
   */
  closeAll() {
    for (const [id, stream] of this.#streams) {
      stream.cancel('Multiplexer closing all streams');
      this.#streams.delete(id);
    }
  }

  // ── Dispatch inbound messages ────────────────────────────────────

  /**
   * Route an inbound message to the correct stream.
   * @param {object} msg - Wire message with `t` and `p` fields
   */
  dispatch(msg) {
    if (!msg || !msg.p) return;
    const streamId = msg.p.streamId;
    if (!streamId) return;

    const hexId = typeof streamId === 'string' ? streamId : streamIdToHex(streamId);

    // STREAM_OPEN: new inbound stream
    if (msg.t === MESH_TYPE.STREAM_OPEN) {
      if (this.#streams.has(hexId)) return; // Duplicate
      if (this.activeCount >= this.#maxConcurrent) {
        this._emit({
          t: 0x15, // STREAM_ERROR
          p: { streamId: hexId, code: 'FLOW_CONTROL', message: 'Too many concurrent streams', retryable: true },
        });
        return;
      }
      const stream = new MeshStream({
        id: typeof streamId === 'string'
          ? new Uint8Array(streamId.match(/.{2}/g).map(h => parseInt(h, 16)))
          : streamId,
        method: msg.p.method,
        ordered: msg.p.ordered !== false,
        encrypted: msg.p.encrypted === true,
        metadata: msg.p.metadata || {},
        initiator: false,
        initialCredits: msg.p.initialCredits ?? STREAM_DEFAULTS.initialCredits,
        multiplexer: this,
      });
      stream._open();
      this.#streams.set(hexId, stream);
      if (this.#onStream) this.#onStream(stream);
      return;
    }

    const stream = this.#streams.get(hexId);
    if (!stream) {
      // Unknown stream — send error
      this._emit({
        t: 0x15,
        p: { streamId: hexId, code: 'INTERNAL', message: 'Unknown stream ID', retryable: false },
      });
      return;
    }

    switch (msg.t) {
      case 0x13: // STREAM_DATA
        stream._receiveData(msg.p.data, msg.p.seq);
        break;
      case 0x14: // STREAM_END
        stream._receiveEnd();
        if (stream.state === 'CLOSED') this.#streams.delete(hexId);
        break;
      case 0x15: // STREAM_ERROR
        stream._receiveError(msg.p.code, msg.p.message);
        this.#streams.delete(hexId);
        break;
      case 0x16: // STREAM_WINDOW_UPDATE
        stream._receiveCredits(msg.p.additionalCredits);
        break;
    }
  }

  // ── Queries ──────────────────────────────────────────────────────

  /**
   * Get a stream by hex ID.
   * @param {string} id
   * @returns {MeshStream|undefined}
   */
  getStream(id) { return this.#streams.get(id); }

  /**
   * List all streams, optionally filtered by state.
   * @param {string} [stateFilter]
   * @returns {MeshStream[]}
   */
  listStreams(stateFilter) {
    const all = [...this.#streams.values()];
    return stateFilter ? all.filter(s => s.state === stateFilter) : all;
  }

  /** Number of non-CLOSED streams. */
  get activeCount() {
    let n = 0;
    for (const s of this.#streams.values()) {
      if (s.state !== 'CLOSED') n++;
    }
    return n;
  }

  /** Total number of tracked streams (including CLOSED). */
  get size() { return this.#streams.size; }

  // ── Internal send helpers (called by MeshStream) ─────────────────

  /** @internal */ _sendData(hexId, data, seq) {
    this._emit({ t: 0x13, p: { streamId: hexId, data, seq } });
  }

  /** @internal */ _sendEnd(hexId, totalBytes) {
    this._emit({ t: 0x14, p: { streamId: hexId, totalBytes } });
  }

  /** @internal */ _sendError(hexId, code, message) {
    this._emit({ t: 0x15, p: { streamId: hexId, code, message, retryable: false } });
    this.#streams.delete(hexId);
  }

  /** @internal */ _sendWindowUpdate(hexId, additionalCredits) {
    this._emit({ t: 0x16, p: { streamId: hexId, additionalCredits } });
  }

  /** @internal Emit a wire message via the onSend callback. */
  _emit(msg) {
    if (this.#onSend) this.#onSend(msg);
  }

  // ── Serialization ────────────────────────────────────────────────

  toJSON() {
    const streams = {};
    for (const [id, stream] of this.#streams) {
      streams[id] = stream.toJSON();
    }
    return { maxConcurrent: this.#maxConcurrent, streams };
  }

  static fromJSON(json, opts = {}) {
    const mux = new StreamMultiplexer({
      maxConcurrentStreams: json.maxConcurrent,
      ...opts,
    });
    for (const [id, data] of Object.entries(json.streams)) {
      const stream = MeshStream.fromJSON(data, mux);
      mux.#streams.set(id, stream);
    }
    return mux;
  }
}
