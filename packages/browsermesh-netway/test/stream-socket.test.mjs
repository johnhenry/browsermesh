import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StreamSocket } from '../src/stream-socket.mjs';

describe('StreamSocket', () => {
  it('write→read roundtrip', async () => {
    const [a, b] = StreamSocket.createPair();
    const data = new Uint8Array([1, 2, 3, 4]);
    await a.write(data);
    const received = await b.read();
    assert.deepEqual(received, data);
    await a.close();
    await b.close();
  });

  it('bidirectional communication', async () => {
    const [a, b] = StreamSocket.createPair();
    await a.write(new Uint8Array([10]));
    await b.write(new Uint8Array([20]));
    const fromA = await b.read();
    const fromB = await a.read();
    assert.deepEqual(fromA, new Uint8Array([10]));
    assert.deepEqual(fromB, new Uint8Array([20]));
    await a.close();
    await b.close();
  });

  it('close→read returns null', async () => {
    const [a, b] = StreamSocket.createPair();
    await a.close();
    const result = await a.read();
    assert.equal(result, null);
    await b.close();
  });

  it('close→write throws SocketClosedError', async () => {
    const [a, b] = StreamSocket.createPair();
    await a.close();
    await assert.rejects(() => a.write(new Uint8Array([1])), { name: 'SocketClosedError' });
    await b.close();
  });

  it('large data transfer', async () => {
    const [a, b] = StreamSocket.createPair();
    const data = new Uint8Array(64 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    await a.write(data);
    const received = await b.read();
    assert.equal(received.length, data.length);
    assert.deepEqual(received, data);
    await a.close();
    await b.close();
  });

  it('multiple writes then reads', async () => {
    const [a, b] = StreamSocket.createPair();
    await a.write(new Uint8Array([1]));
    await a.write(new Uint8Array([2]));
    await a.write(new Uint8Array([3]));
    const r1 = await b.read();
    const r2 = await b.read();
    const r3 = await b.read();
    assert.deepEqual(r1, new Uint8Array([1]));
    assert.deepEqual(r2, new Uint8Array([2]));
    assert.deepEqual(r3, new Uint8Array([3]));
    await a.close();
    await b.close();
  });

  it('closed property', async () => {
    const [a, b] = StreamSocket.createPair();
    assert.equal(a.closed, false);
    await a.close();
    assert.equal(a.closed, true);
    await b.close();
  });
});
