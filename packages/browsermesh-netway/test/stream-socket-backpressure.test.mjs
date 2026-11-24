import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StreamSocket, STREAM_DEFAULTS } from '../src/stream-socket.mjs';

/**
 * Everything here runs on promises only (no timers, no I/O), so one
 * macrotask turn is enough for every pending microtask chain to finish:
 * after `settle()` a write that is still pending is genuinely blocked.
 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function track(promise) {
  const state = { settled: false, error: null };
  promise.then(() => { state.settled = true; }, (err) => { state.settled = true; state.error = err; });
  return state;
}

const bytes = (n, fill = 0) => new Uint8Array(n).fill(fill);

describe('StreamSocket byte backpressure', () => {
  it('states its defaults', () => {
    assert.deepEqual({ ...STREAM_DEFAULTS }, {
      highWaterBytes: 1024 * 1024,
      lowWaterBytes: 256 * 1024,
      maxBufferedBytes: 4 * 1024 * 1024,
    });
  });

  it('a write is accepted while the buffered bytes are under the high-water mark', async () => {
    const [a, b] = StreamSocket.createPair({ highWaterBytes: 100, lowWaterBytes: 40 });
    const w1 = track(a.write(bytes(60)));
    const w2 = track(a.write(bytes(60)));
    await settle();
    assert.equal(w1.settled, true);
    assert.equal(w2.settled, true, 'the second write starts under the mark, so it is accepted');
    assert.equal(a.bufferedOutbound, 120);
    assert.equal(b.bufferedInbound, 120);
  });

  it('pauses a write over the high-water mark and resumes it only under the low-water mark, in order', async () => {
    const [a, b] = StreamSocket.createPair({ highWaterBytes: 100, lowWaterBytes: 40 });
    await a.write(bytes(60, 1));
    await a.write(bytes(60, 2));
    const third = track(a.write(bytes(10, 3)));
    await settle();
    assert.equal(third.settled, false, 'blocked: buffered 120 >= 100');
    assert.equal(a.bufferedOutbound, 120, 'the blocked chunk is not in the buffer');

    const r1 = await b.read();
    assert.equal(r1[0], 1);
    await settle();
    assert.equal(third.settled, false, 'buffered 60 is still above the low-water mark of 40');

    const r2 = await b.read();
    assert.equal(r2[0], 2);
    await settle();
    assert.equal(third.settled, true, 'buffered 0 is under the low-water mark');
    assert.equal(third.error, null);
    const r3 = await b.read();
    assert.equal(r3[0], 3);
    assert.equal(r3.length, 10);
  });

  it('never drops: a fast writer and a slow reader deliver every byte in order', async () => {
    const [a, b] = StreamSocket.createPair({ highWaterBytes: 64, lowWaterBytes: 16 });
    const total = 500;
    const writer = (async () => {
      for (let i = 0; i < total; i++) await a.write(new Uint8Array([i & 0xff, (i >> 8) & 0xff, 0, 0, 0, 0, 0, 0]));
    })();
    let max = 0;
    for (let i = 0; i < total; i++) {
      max = Math.max(max, a.bufferedOutbound);
      const chunk = await b.read();
      assert.notEqual(chunk, null);
      assert.equal(chunk[0] | (chunk[1] << 8), i, `chunk ${i} arrived in order`);
    }
    await writer;
    assert.ok(max <= 64 + 8, `buffered bytes stayed bounded (max ${max})`);
  });

  it('closes with a reason when the hard cap is exceeded, and the peer can see why', async () => {
    const [a, b] = StreamSocket.createPair({ highWaterBytes: 100, lowWaterBytes: 40, maxBufferedBytes: 150 });
    await a.write(bytes(90));
    await assert.rejects(() => a.write(bytes(90)), { name: 'SocketClosedError' });
    assert.match(a.closeReason, /buffer limit/);
    assert.match(b.closeReason, /buffer limit/);
    assert.equal(await b.read(), null);
  });

  it('a single chunk larger than every mark is accepted when nothing is buffered', async () => {
    const [a, b] = StreamSocket.createPair({ highWaterBytes: 10, lowWaterBytes: 5, maxBufferedBytes: 20 });
    await a.write(bytes(1000));
    assert.equal((await b.read()).length, 1000);
  });

  it('close() rejects writers that are waiting, and records the reason for the peer', async () => {
    const [a, b] = StreamSocket.createPair({ highWaterBytes: 10, lowWaterBytes: 5 });
    await a.write(bytes(20));
    const waiting = track(a.write(bytes(1)));
    await settle();
    assert.equal(waiting.settled, false);
    await b.close('revoked');
    await settle();
    assert.equal(waiting.settled, true);
    assert.equal(waiting.error?.name, 'SocketClosedError');
    assert.equal(a.closeReason, 'revoked');
    assert.equal(b.closeReason, 'revoked');
  });

  it('the chunk-count limit still closes, now with a reason', async () => {
    const [a, b] = StreamSocket.createPair({ highWaterMark: 3 });
    await a.write(bytes(1));
    await a.write(bytes(1));
    await a.write(bytes(1)).catch(() => {});
    await assert.rejects(() => a.write(bytes(1)), { name: 'SocketClosedError' });
    assert.match(b.closeReason, /queue limit/);
  });

  it('zero disables the byte limits', async () => {
    const [a] = StreamSocket.createPair({ highWaterBytes: 0, lowWaterBytes: 0, maxBufferedBytes: 0 });
    for (let i = 0; i < 10; i++) await a.write(bytes(1024 * 1024));
    assert.equal(a.bufferedOutbound, 10 * 1024 * 1024);
  });

  it('rejects a low-water mark that is not below the high-water mark', () => {
    assert.throws(() => StreamSocket.createPair({ highWaterBytes: 10, lowWaterBytes: 10 }), /lowWaterBytes/);
  });
});
