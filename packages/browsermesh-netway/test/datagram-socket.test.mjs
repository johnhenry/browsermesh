import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatagramSocket } from '../src/datagram-socket.mjs';

describe('DatagramSocket', () => {
  it('send calls sendFn', async () => {
    const sent = [];
    const socket = new DatagramSocket({
      sendFn: async (addr, data) => sent.push({ addr, data }),
      localPort: 5000,
    });
    await socket.send('localhost:5001', new Uint8Array([1, 2]));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].addr, 'localhost:5001');
    assert.deepEqual(sent[0].data, new Uint8Array([1, 2]));
    socket.close();
  });

  it('onMessage receives delivered data', () => {
    const socket = new DatagramSocket({
      sendFn: async () => {},
      localPort: 5000,
    });
    const received = [];
    socket.onMessage((from, data) => received.push({ from, data }));
    socket._deliver('10.0.0.1:4000', new Uint8Array([42]));
    assert.equal(received.length, 1);
    assert.equal(received[0].from, '10.0.0.1:4000');
    assert.deepEqual(received[0].data, new Uint8Array([42]));
    socket.close();
  });

  it('close prevents send', async () => {
    const socket = new DatagramSocket({
      sendFn: async () => {},
      localPort: 5000,
    });
    socket.close();
    await assert.rejects(
      () => socket.send('localhost:5001', new Uint8Array([1])),
      { name: 'SocketClosedError' }
    );
  });

  it('close prevents delivery', () => {
    const socket = new DatagramSocket({
      sendFn: async () => {},
      localPort: 5000,
    });
    const received = [];
    socket.onMessage((from, data) => received.push({ from, data }));
    socket.close();
    socket._deliver('10.0.0.1:4000', new Uint8Array([42]));
    assert.equal(received.length, 0);
  });

  it('localPort is accessible', () => {
    const socket = new DatagramSocket({
      sendFn: async () => {},
      localPort: 7777,
    });
    assert.equal(socket.localPort, 7777);
    socket.close();
  });

  it('closed property', () => {
    const socket = new DatagramSocket({
      sendFn: async () => {},
      localPort: 5000,
    });
    assert.equal(socket.closed, false);
    socket.close();
    assert.equal(socket.closed, true);
  });
});
