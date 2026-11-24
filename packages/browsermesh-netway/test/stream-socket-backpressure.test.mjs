import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { StreamSocket, AsyncBuffer, DEFAULT_WINDOW_BYTES } from '../src/stream-socket.mjs';

// Let every promise continuation already queued run (no timers, no wall clock).
const settle = () => new Promise((resolve) => setImmediate(resolve));

function track(promise) {
  const state = { settled: false, error: null };
  promise.then(() => { state.settled = true; }, (e) => { state.settled = true; state.error = e; });
  return state;
}

const pattern = (n, seed = 1) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
};

describe('StreamSocket backpressure: a reader that does not read stops the writer', () => {
  it('holds at most the window at the receiver and the rest at the writer', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 1000 });
    const w = track(a.write(pattern(10_000)));
    await settle();
    assert.equal(b.readableLength, 1000);
    assert.equal(a.writableLength, 9000);
    assert.equal(w.settled, false, 'write must not resolve while the peer holds the bytes');

    let total = 0;
    while (total < 10_000) {
      const chunk = await b.read();
      total += chunk.length;
      await settle();
      assert.ok(b.readableLength <= 1000, `receiver held ${b.readableLength} bytes`);
    }
    assert.equal(total, 10_000);
    assert.equal(w.settled, true);
    assert.equal(w.error, null);
    assert.equal(a.writableLength, 0);
  });

  it('many tiny writes are bounded by bytes, not only by chunk count', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 100, highWaterMark: 0 });
    const writes = Array.from({ length: 5000 }, () => a.write(new Uint8Array(1)));
    await settle();
    assert.equal(b.readableLength, 100);
    assert.equal(a.writableLength, 4900);
    for (let i = 0; i < 5000; i++) await b.read();
    await Promise.all(writes);
    assert.equal(a.writableLength, 0);
    assert.equal(b.readableLength, 0);
  });

  it('the chunk cap makes a windowed writer wait instead of closing the socket', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 1_000_000, highWaterMark: 3 });
    const writes = Array.from({ length: 5 }, (_, i) => a.write(new Uint8Array([i])));
    await settle();
    assert.equal(b.readableLength, 3);
    assert.equal(a.writableLength, 2);
    assert.equal(a.closed, false);
    const got = [];
    for (let i = 0; i < 5; i++) got.push((await b.read())[0]);
    await Promise.all(writes);
    assert.deepEqual(got, [0, 1, 2, 3, 4]);
  });

  it('concurrent writes are delivered in call order', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 4 });
    const sent = [pattern(10, 1), pattern(7, 2), pattern(12, 3)];
    const writes = sent.map((s) => a.write(s));
    const expected = Buffer.concat(sent);
    const got = [];
    let n = 0;
    while (n < expected.length) {
      const c = await b.read();
      got.push(Buffer.from(c));
      n += c.length;
    }
    await Promise.all(writes);
    assert.ok(Buffer.concat(got).equals(expected));
  });

  it('a zero-length write is a no-op', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 4 });
    await a.write(new Uint8Array(0));
    assert.equal(b.readableLength, 0);
    assert.equal(a.writableLength, 0);
  });

  it('defaults to a finite window', () => {
    const [a, b] = StreamSocket.createPair();
    assert.equal(a.windowBytes, DEFAULT_WINDOW_BYTES);
    assert.equal(b.peerWindowBytes, DEFAULT_WINDOW_BYTES);
    assert.ok(Number.isFinite(DEFAULT_WINDOW_BYTES) && DEFAULT_WINDOW_BYTES > 0);
  });
});

describe('StreamSocket backpressure: large transfers', () => {
  it('arrive intact through a small window with a concurrent reader', async () => {
    const total = 3 * 1024 * 1024;
    const data = pattern(total, 7);
    const [a, b] = StreamSocket.createPair({ windowBytes: 4096 });
    let maxHeld = 0;

    const writer = (async () => {
      for (let off = 0; off < total; off += 100_000) {
        await a.write(data.subarray(off, Math.min(total, off + 100_000)));
      }
      await a.end();
    })();

    const hash = createHash('sha256');
    let received = 0;
    for (;;) {
      maxHeld = Math.max(maxHeld, b.readableLength);
      const c = await b.read();
      if (c === null) break;
      received += c.length;
      hash.update(c);
    }
    await writer;
    assert.equal(received, total);
    assert.equal(hash.digest('hex'), createHash('sha256').update(data).digest('hex'));
    assert.ok(maxHeld <= 4096, `receiver held up to ${maxHeld} bytes`);
  });

  it('both directions at once with independent windows', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: [512, 2048] });
    const x = pattern(50_000, 3);
    const y = pattern(70_000, 5);
    const drain = async (s, len) => {
      const parts = [];
      let n = 0;
      while (n < len) { const c = await s.read(); parts.push(Buffer.from(c)); n += c.length; }
      return Buffer.concat(parts);
    };
    const [gotAtB, gotAtA] = await Promise.all([drain(b, x.length), drain(a, y.length), a.write(x), b.write(y)]);
    assert.ok(gotAtB.equals(Buffer.from(x)));
    assert.ok(gotAtA.equals(Buffer.from(y)));
  });
});

describe('StreamSocket backpressure: older peers (no window) are served as before', () => {
  it('writing to a peer with no window resolves at once, with no limit but the chunk cap', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: [DEFAULT_WINDOW_BYTES, 0] });
    assert.equal(a.peerWindowBytes, 0);
    await a.write(new Uint8Array(5 * 1024 * 1024)); // would stall against a window
    assert.equal(a.writableLength, 0);
    assert.equal((await b.read()).length, 5 * 1024 * 1024);
  });

  it('an unwindowed buffer still closes at the chunk cap, as it always did', async () => {
    const [a] = StreamSocket.createPair({ windowBytes: 0, highWaterMark: 3 });
    await a.write(new Uint8Array(1));
    await a.write(new Uint8Array(1));
    await assert.rejects(() => a.write(new Uint8Array(1)), { name: 'SocketClosedError' });
  });

  // The pre-window buffer, verbatim in behavior: push/pull/close only.
  class OldBuffer {
    #queue = []; #waiters = []; #closed = false;
    push(d) {
      if (this.#closed) return false;
      if (this.#waiters.length) { this.#waiters.shift()(d); return true; }
      this.#queue.push(d);
      return true;
    }
    pull() {
      if (this.#queue.length) return Promise.resolve(this.#queue.shift());
      if (this.#closed) return Promise.resolve(null);
      return new Promise((r) => this.#waiters.push(r));
    }
    close() { this.#closed = true; for (const w of this.#waiters) w(null); this.#waiters.length = 0; this.#queue.length = 0; }
    get isClosed() { return this.#closed; }
  }

  it('a socket whose peer is an old-style buffer pair exchanges data both ways', async () => {
    const toOld = new OldBuffer();
    const fromOld = new OldBuffer();
    const sock = new StreamSocket({ inbound: fromOld, outbound: toOld });
    assert.equal(sock.peerWindowBytes, 0);

    await sock.write(new Uint8Array([1, 2, 3]));
    assert.deepEqual(await toOld.pull(), new Uint8Array([1, 2, 3]));
    fromOld.push(new Uint8Array([9]));
    assert.deepEqual(await sock.read(), new Uint8Array([9]));

    await sock.end(); // old buffers have only close()
    assert.equal(await toOld.pull(), null);
    await sock.close();
  });

  it('an old sender that ignores credit can overrun a windowed receiver without loss', async () => {
    const inbound = new AsyncBuffer({ windowBytes: 4, highWaterMark: 1024 });
    const sock = new StreamSocket({ inbound, outbound: new OldBuffer() });
    for (let i = 0; i < 5; i++) assert.equal(inbound.push(pattern(10, i)), true); // legacy push, no credit
    for (let i = 0; i < 5; i++) assert.deepEqual(await sock.read(), pattern(10, i));
  });
});

describe('StreamSocket half-close and close', () => {
  it('end() stops writing, flushes what was sent, and leaves the other direction open', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 4 });
    const w = a.write(pattern(10)); // blocked on the window
    const ended = track(a.end());
    await settle();
    assert.equal(ended.settled, false, 'end() waits for accepted writes');

    const got = [];
    let n = 0;
    while (n < 10) { const c = await b.read(); got.push(Buffer.from(c)); n += c.length; }
    await w;
    assert.ok(Buffer.concat(got).equals(Buffer.from(pattern(10))));
    assert.equal(await b.read(), null, 'EOF after the data');
    assert.equal(ended.settled, true);

    await assert.rejects(() => a.write(new Uint8Array(1)), { name: 'SocketClosedError' });
    await b.write(new Uint8Array([5, 6])); // the other direction still works
    assert.deepEqual(await a.read(), new Uint8Array([5, 6]));
    assert.equal(a.closed, false);
  });

  it('close() leaves what was already written readable by the peer, then EOF', async () => {
    const [a, b] = StreamSocket.createPair();
    await a.write(new Uint8Array([1]));
    await a.write(new Uint8Array([2]));
    await a.close();
    assert.deepEqual(await b.read(), new Uint8Array([1]));
    assert.deepEqual(await b.read(), new Uint8Array([2]));
    assert.equal(await b.read(), null);
    await assert.rejects(() => b.write(new Uint8Array([3])), { name: 'SocketClosedError' });
  });

  it('close() rejects a write that is still waiting for credit, and its bytes stop counting', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 10 });
    const w = track(a.write(pattern(100)));
    await settle();
    assert.equal(a.writableLength, 90);
    await a.close();
    await settle();
    assert.equal(w.settled, true);
    assert.equal(w.error?.name, 'SocketClosedError');
    assert.equal(a.writableLength, 0);
    assert.equal((await b.read()).length, 10, 'the accepted part is still readable');
    assert.equal(await b.read(), null);
  });

  it("the peer's close() rejects a write that is waiting for credit", async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 10 });
    const w = track(a.write(pattern(100)));
    await settle();
    await b.close();
    await settle();
    assert.equal(w.error?.name, 'SocketClosedError');
    assert.equal(a.writableLength, 0);
  });

  it('read() returns null after the socket itself is closed', async () => {
    const [a] = StreamSocket.createPair();
    await a.close();
    assert.equal(await a.read(), null);
  });
});

describe('StreamSocket errors', () => {
  it('destroy(err) rejects the peer\'s pending and later reads with err, and fails its writes', async () => {
    const [a, b] = StreamSocket.createPair();
    const pending = b.read();
    const boom = new Error('boom');
    a.destroy(boom);
    await assert.rejects(pending, boom);
    await assert.rejects(() => b.read(), boom);
    await assert.rejects(() => b.write(new Uint8Array(1)), { name: 'SocketClosedError' });
    assert.equal(await a.read(), null);
    assert.equal(a.closed, true);
  });

  it('destroy(err) fails a write waiting for credit and drops its pending bytes', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 10 });
    const w = track(b.write(pattern(100)));
    await settle();
    a.destroy(new Error('gone'));
    await settle();
    assert.equal(w.error?.name, 'SocketClosedError');
    assert.equal(b.writableLength, 0);
  });
});

describe('StreamSocket Web Streams views', () => {
  it('writable/readable carry data through the window and half-close on writer.close()', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 8 });
    const data = pattern(100, 9);
    const writer = a.writable.getWriter();
    const sending = (async () => { await writer.write(data); await writer.close(); })();
    const reader = b.readable.getReader();
    const parts = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      assert.ok(b.readableLength <= 8);
      parts.push(Buffer.from(value));
    }
    await sending;
    assert.ok(Buffer.concat(parts).equals(Buffer.from(data)));
  });
});
