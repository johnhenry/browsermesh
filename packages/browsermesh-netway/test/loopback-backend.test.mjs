import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LoopbackBackend } from '../src/loopback-backend.mjs';

describe('LoopbackBackend', () => {
  it('listen→connect→bidirectional data', async () => {
    const backend = new LoopbackBackend();
    const listener = await backend.listen(8080);
    assert.equal(listener.localPort, 8080);

    const clientSocket = await backend.connect('localhost', 8080);
    const serverSocket = await listener.accept();

    // Client → server
    await clientSocket.write(new Uint8Array([1, 2, 3]));
    const fromClient = await serverSocket.read();
    assert.deepEqual(fromClient, new Uint8Array([1, 2, 3]));

    // Server → client
    await serverSocket.write(new Uint8Array([4, 5, 6]));
    const fromServer = await clientSocket.read();
    assert.deepEqual(fromServer, new Uint8Array([4, 5, 6]));

    await clientSocket.close();
    await serverSocket.close();
    listener.close();
    await backend.close();
  });

  it('multi-client connections', async () => {
    const backend = new LoopbackBackend();
    const listener = await backend.listen(9090);

    const clients = [];
    const serverSockets = [];

    for (let i = 0; i < 5; i++) {
      clients.push(await backend.connect('localhost', 9090));
      serverSockets.push(await listener.accept());
    }

    // Each client sends unique data
    for (let i = 0; i < 5; i++) {
      await clients[i].write(new Uint8Array([i]));
      const data = await serverSockets[i].read();
      assert.deepEqual(data, new Uint8Array([i]));
    }

    for (const s of [...clients, ...serverSockets]) await s.close();
    listener.close();
    await backend.close();
  });

  it('port 0 auto-assigns', async () => {
    const backend = new LoopbackBackend();
    const listener = await backend.listen(0);
    assert.ok(listener.localPort >= 49152);
    assert.ok(listener.localPort <= 65535);
    listener.close();
    await backend.close();
  });

  it('connect to no listener throws ConnectionRefusedError', async () => {
    const backend = new LoopbackBackend();
    await assert.rejects(
      () => backend.connect('localhost', 9999),
      { name: 'ConnectionRefusedError' }
    );
    await backend.close();
  });

  it('duplicate port throws AddressInUseError', async () => {
    const backend = new LoopbackBackend();
    await backend.listen(7070);
    await assert.rejects(
      () => backend.listen(7070),
      { name: 'AddressInUseError' }
    );
    await backend.close();
  });

  it('UDP send/receive cycle', async () => {
    const backend = new LoopbackBackend();
    const socket = await backend.bindDatagram(5353);

    const received = [];
    socket.onMessage((from, data) => received.push({ from, data }));

    await backend.sendDatagram('localhost', 5353, new Uint8Array([0xDE, 0xAD]));
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].data, new Uint8Array([0xDE, 0xAD]));

    socket.close();
    await backend.close();
  });

  it('UDP send to no receiver is silently dropped', async () => {
    const backend = new LoopbackBackend();
    // Should not throw
    await backend.sendDatagram('localhost', 9999, new Uint8Array([1]));
    await backend.close();
  });

  it('UDP socket send routes locally', async () => {
    const backend = new LoopbackBackend();
    const socketA = await backend.bindDatagram(6000);
    const socketB = await backend.bindDatagram(6001);

    const received = [];
    socketB.onMessage((from, data) => received.push({ from, data }));

    await socketA.send('localhost:6001', new Uint8Array([42]));
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].data, new Uint8Array([42]));

    socketA.close();
    socketB.close();
    await backend.close();
  });

  it('resolve always returns 127.0.0.1', async () => {
    const backend = new LoopbackBackend();
    const result = await backend.resolve('anything', 'A');
    assert.deepEqual(result, ['127.0.0.1']);
    await backend.close();
  });

  it('close cleans up all resources', async () => {
    const backend = new LoopbackBackend();
    const listener = await backend.listen(7777);
    const socket = await backend.bindDatagram(7778);
    await backend.close();
    // After close, connect should fail
    await assert.rejects(() => backend.connect('localhost', 7777), { name: 'ConnectionRefusedError' });
  });
});
