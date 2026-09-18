import { encodeEnvelope, decodeEnvelope } from './envelope.mjs';
import { encodeChunkFrame, decodeChunkFrame, splitIntoChunks } from './frame.mjs';
import { PriorityScheduler, DEFAULT_TIERS, DEFAULT_STARVATION_GUARD_INTERVAL } from './scheduler.mjs';
import { Reassembler } from './reassembler.mjs';

/** Default chunk size in bytes: large messages above this get split. */
export const DEFAULT_CHUNK_SIZE = 16 * 1024;

/** Events re-emitted by PriorityMux. */
const EVENTS = Object.freeze(['open', 'message', 'close', 'error']);

const defaultSchedule = typeof setImmediate === 'function'
  ? setImmediate
  : (fn) => setTimeout(fn, 0);

/**
 * PriorityMux -- an application-level scheduler that prevents head-of-line
 * blocking on a single ordered byte-stream transport (WebSocket and
 * similar) by chunking large messages and interleaving them with small,
 * high-priority ones, borrowing the scheduling idea (not the wire
 * protocol) from Homa's SRPT-style short-message prioritization.
 *
 * Transport-agnostic: wraps anything shaped like
 * `{ send(bytes), on(event, cb), close() }` -- the same adapter shape
 * `@johnhenry/browsermesh-transport`'s `WebSocketTransport` (and its
 * WebRTC/WebTransport siblings) already exposes. PriorityMux itself
 * exposes that exact same shape back out, so it drops in as a transparent
 * wrapper: anywhere code did `transport.send(x)` / `transport.on('message', cb)`,
 * it can instead do `mux.send(x)` / `mux.on('message', cb)` unchanged.
 */
export class PriorityMux {
  #adapter;
  #chunkSize;
  #tiers;
  #priorityOf;
  #defaultPriority;
  #scheduleFn;
  #scheduler;
  #reassembler = new Reassembler();
  #callbacks = { open: [], message: [], close: [], error: [] };
  #draining = false;
  #closed = false;
  #nextMsgId = Math.floor(Math.random() * 0xfffffffe) >>> 0;
  #stats = { chunksSent: 0, chunksReceived: 0, messagesSent: 0, messagesReceived: 0 };

  /**
   * @param {{ send(bytes: Uint8Array): void, on(event: string, cb: Function): void, close?: Function }} adapter
   * @param {object} [opts]
   * @param {number} [opts.chunkSize=16384] - Messages whose encoded byte
   *   length exceeds this get split into multiple chunk frames.
   * @param {string[]} [opts.tiers=['high','normal','low']] - Priority tier
   *   names, highest priority first. `send()`'s `priority` option and any
   *   `priorityOf()` classifier must return one of these.
   * @param {number} [opts.starvationGuardInterval=8] - Anti-starvation
   *   bound: every Nth drain slot is reserved for the lowest non-empty
   *   tier regardless of higher-tier backlog. See `PriorityScheduler`.
   * @param {(parsedEnvelope: *) => (string|undefined|null)} [opts.priorityOf]
   *   Optional classifier: given the *original* value passed to `send()`
   *   (before wire encoding), return a tier name to auto-derive priority.
   *   Domain-specific message-shape knowledge belongs here, supplied by
   *   the caller -- this package stays domain-agnostic.
   * @param {string} [opts.defaultPriority='normal'] - Used when neither an
   *   explicit `send()` option nor `priorityOf()` yields a tier.
   * @param {(fn: Function) => void} [opts.scheduleFn] - Injectable drain
   *   scheduler (defaults to `setImmediate`, falling back to
   *   `setTimeout(fn, 0)`). Exposed mainly for deterministic tests.
   */
  constructor(adapter, opts = {}) {
    if (!adapter || typeof adapter.send !== 'function' || typeof adapter.on !== 'function') {
      throw new Error('priority-mux: adapter must have send() and on()');
    }
    this.#adapter = adapter;
    this.#chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (this.#chunkSize < 1) throw new Error('priority-mux: chunkSize must be >= 1');
    this.#tiers = opts.tiers || DEFAULT_TIERS;
    this.#priorityOf = opts.priorityOf || null;
    this.#defaultPriority = opts.defaultPriority || (this.#tiers.includes('normal') ? 'normal' : this.#tiers[0]);
    this.#scheduleFn = opts.scheduleFn || defaultSchedule;
    this.#scheduler = new PriorityScheduler({
      tiers: this.#tiers,
      starvationGuardInterval: opts.starvationGuardInterval ?? DEFAULT_STARVATION_GUARD_INTERVAL,
    });

    this.#adapter.on('message', (raw) => this.#handleIncoming(raw));
    this.#adapter.on('close', (ev) => this.#handleClose(ev));
    this.#adapter.on('open', (ev) => this.#emit('open', ev));
    this.#adapter.on('error', (err) => this.#emit('error', err));
  }

  /**
   * Send a message, transparently chunking it if it's large and queuing
   * each chunk under the resolved priority tier.
   * @param {Uint8Array|ArrayBuffer|string|*} data
   * @param {{ priority?: string }} [opts]
   * @returns {{ msgId: number, total: number, priority: string }}
   */
  send(data, opts = {}) {
    if (this.#closed) throw new Error('priority-mux: mux is closed');

    const priority = opts.priority
      || (this.#priorityOf ? this.#priorityOf(data) : null)
      || this.#defaultPriority;
    if (!this.#tiers.includes(priority)) {
      throw new Error(`priority-mux: unknown priority tier "${priority}"`);
    }

    const envelopeBytes = encodeEnvelope(data);
    const msgId = this.#allocMsgId();
    const chunks = splitIntoChunks(envelopeBytes, this.#chunkSize);

    for (const { seq, total, payload } of chunks) {
      this.#scheduler.enqueue(priority, { priority, msgId, seq, total, payload });
    }
    this.#stats.messagesSent++;
    this.#scheduleDrain();

    return { msgId, total: chunks.length, priority };
  }

  /**
   * Register a listener. Supported events: 'open', 'message', 'close', 'error'.
   * @param {string} event
   * @param {Function} cb
   */
  on(event, cb) {
    if (!EVENTS.includes(event)) throw new Error(`priority-mux: unknown event "${event}"`);
    this.#callbacks[event].push(cb);
  }

  /**
   * Close the underlying adapter (if it supports `close()`) and stop
   * draining. Safe to call more than once.
   */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (typeof this.#adapter.close === 'function') {
      this.#adapter.close();
    }
    this.#reassembler.reset();
  }

  /** Snapshot of internal counters, useful for tests/observability. */
  getStats() {
    return {
      ...this.#stats,
      pendingReassembly: this.#reassembler.pendingCount,
      queued: this.#scheduler.size,
    };
  }

  // -- Internal ----------------------------------------------------------

  #allocMsgId() {
    const id = this.#nextMsgId;
    this.#nextMsgId = (this.#nextMsgId + 1) >>> 0;
    return id;
  }

  #handleIncoming(raw) {
    let frame;
    try {
      frame = decodeChunkFrame(raw);
    } catch (err) {
      this.#emit('error', err);
      return;
    }

    this.#stats.chunksReceived++;

    let result;
    try {
      result = this.#reassembler.receive(frame);
    } catch (err) {
      this.#emit('error', err);
      return;
    }
    if (!result) return; // message still incomplete

    let value;
    try {
      value = decodeEnvelope(result.bytes);
    } catch (err) {
      this.#emit('error', err);
      return;
    }

    this.#stats.messagesReceived++;
    this.#emit('message', value, { msgId: result.msgId, priority: result.priority });
  }

  #handleClose(ev) {
    // Closing mid-flight must not leave partially-reassembled messages
    // sitting around waiting for chunks that will never arrive, and must
    // not leave the drain loop scheduling forever against a dead adapter.
    this.#closed = true;
    this.#draining = false;
    this.#reassembler.reset();
    this.#emit('close', ev);
  }

  #scheduleDrain() {
    if (this.#draining || this.#closed) return;
    this.#draining = true;
    this.#scheduleFn(() => this.#drainTick());
  }

  #drainTick() {
    if (this.#closed) {
      this.#draining = false;
      return;
    }
    const item = this.#scheduler.dequeue();
    if (!item) {
      this.#draining = false;
      return;
    }
    try {
      this.#adapter.send(encodeChunkFrame(item));
      this.#stats.chunksSent++;
    } catch (err) {
      this.#draining = false;
      this.#emit('error', err);
      return;
    }
    this.#scheduleFn(() => this.#drainTick());
  }

  #emit(event, ...args) {
    for (const cb of this.#callbacks[event] || []) {
      try { cb(...args); } catch { /* listener errors must not break the mux */ }
    }
  }
}
