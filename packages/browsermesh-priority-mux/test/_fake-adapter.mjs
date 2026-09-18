/**
 * _fake-adapter.mjs -- a real, minimal transport-agnostic adapter test
 * double implementing the `{ send(bytes), on(event, cb), close() }` shape
 * PriorityMux wraps. Not a mock shaped to match a specific expected call
 * sequence: `pairFakeAdapters()` wires two of them together with a real
 * asynchronous delivery hop (`setImmediate` by default), so sends from one
 * side genuinely arrive on the other side's 'message' listeners on a later
 * event-loop turn -- exercising real async ordering, not a synchronous
 * call-through.
 */

const EVENTS = ['open', 'message', 'close', 'error'];

export class FakeAdapter {
  #listeners = { open: [], message: [], close: [], error: [] };
  outbox = [];
  closed = false;

  send(bytes) {
    if (this.closed) throw new Error('fake-adapter: cannot send, adapter is closed');
    this.outbox.push(bytes);
  }

  on(event, cb) {
    if (!EVENTS.includes(event)) throw new Error(`fake-adapter: unknown event "${event}"`);
    this.#listeners[event].push(cb);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._emit('close');
  }

  /** Test-only: simulate an inbound message arriving from "the network". */
  _deliver(bytes) {
    if (this.closed) return;
    this._emit('message', bytes);
  }

  _emit(event, ...args) {
    for (const cb of this.#listeners[event] || []) cb(...args);
  }
}

/**
 * Wire two FakeAdapters together so that `a.send(bytes)` results in
 * `b`'s 'message' listeners firing on a later tick (and vice versa),
 * simulating real network transit instead of a synchronous echo.
 * @param {{ scheduleFn?: (fn: Function) => void }} [opts]
 * @returns {[FakeAdapter, FakeAdapter]}
 */
export function pairFakeAdapters(opts = {}) {
  const a = new FakeAdapter();
  const b = new FakeAdapter();
  const schedule = opts.scheduleFn || ((fn) => setImmediate(fn));

  const aSend = a.send.bind(a);
  a.send = (bytes) => {
    aSend(bytes);
    schedule(() => b._deliver(bytes));
  };

  const bSend = b.send.bind(b);
  b.send = (bytes) => {
    bSend(bytes);
    schedule(() => a._deliver(bytes));
  };

  return [a, b];
}
