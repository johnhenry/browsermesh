import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualNetwork } from '../src/virtual-network.mjs';
import { CAPABILITY } from '../src/constants.mjs';

describe('Integration', () => {
  it('echo server', async () => {
    const net = new VirtualNetwork();

    // Start echo server
    const listener = await net.listen('mem://localhost:7000');
    const serverLoop = (async () => {
      const conn = await listener.accept();
      if (!conn) return;
      const data = await conn.read();
      if (data) await conn.write(data);
      await conn.close();
    })();

    // Client sends and receives
    const client = await net.connect('mem://localhost:7000');
    await client.write(new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]));
    const echo = await client.read();
    assert.deepEqual(echo, new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]));

    await client.close();
    await serverLoop;
    listener.close();
    await net.close();
  });

  it('multi-client echo server', async () => {
    const net = new VirtualNetwork();
    const listener = await net.listen('mem://localhost:7001');

    // Server accepts and echoes for multiple clients
    const serverLoop = (async () => {
      for (let i = 0; i < 5; i++) {
        const conn = await listener.accept();
        if (!conn) break;
        const data = await conn.read();
        if (data) await conn.write(data);
        await conn.close();
      }
    })();

    // 5 concurrent clients
    const results = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        const client = await net.connect('mem://localhost:7001');
        await client.write(new Uint8Array([i]));
        const echo = await client.read();
        await client.close();
        return echo;
      })
    );

    for (let i = 0; i < 5; i++) {
      assert.deepEqual(results[i], new Uint8Array([i]));
    }

    await serverLoop;
    listener.close();
    await net.close();
  });

  it('UDP ping-pong', async () => {
    const net = new VirtualNetwork();

    const socketA = await net.bindDatagram('mem://localhost:6000');
    const socketB = await net.bindDatagram('mem://localhost:6001');

    const receivedByA = [];
    const receivedByB = [];
    socketA.onMessage((from, data) => receivedByA.push(data));
    socketB.onMessage((from, data) => receivedByB.push(data));

    // A → B
    await socketA.send('localhost:6001', new Uint8Array([1]));
    assert.equal(receivedByB.length, 1);
    assert.deepEqual(receivedByB[0], new Uint8Array([1]));

    // B → A
    await socketB.send('localhost:6000', new Uint8Array([2]));
    assert.equal(receivedByA.length, 1);
    assert.deepEqual(receivedByA[0], new Uint8Array([2]));

    socketA.close();
    socketB.close();
    await net.close();
  });

  it('policy denial', async () => {
    const net = new VirtualNetwork();
    const scoped = net.scope({ capabilities: [] });

    await assert.rejects(
      () => scoped.connect('mem://localhost:8000'),
      { name: 'PolicyDeniedError' }
    );

    await assert.rejects(
      () => scoped.listen('mem://localhost:8000'),
      { name: 'PolicyDeniedError' }
    );

    await assert.rejects(
      () => scoped.sendDatagram('mem://localhost:8000', new Uint8Array([1])),
      { name: 'PolicyDeniedError' }
    );

    await assert.rejects(
      () => scoped.resolve('example.com'),
      { name: 'PolicyDeniedError' }
    );

    await net.close();
  });

  it('lifecycle: create→use→close→verify cleanup', async () => {
    const net = new VirtualNetwork();

    // Create resources
    const listener = await net.listen('mem://localhost:9000');
    const client = await net.connect('mem://localhost:9000');
    const server = await listener.accept();
    const udpSocket = await net.bindDatagram('mem://localhost:9001');

    // Use resources
    await client.write(new Uint8Array([42]));
    const data = await server.read();
    assert.deepEqual(data, new Uint8Array([42]));

    // Close everything
    await client.close();
    await server.close();
    listener.close();
    udpSocket.close();
    await net.close();

    // Verify cleanup
    assert.equal(client.closed, true);
    assert.equal(server.closed, true);
    assert.equal(listener.closed, true);
    assert.equal(udpSocket.closed, true);
  });

  it('port 0 auto-assign on listen', async () => {
    const net = new VirtualNetwork();
    const listener = await net.listen('mem://localhost:0');
    assert.ok(listener.localPort >= 49152);

    // Can connect to the auto-assigned port via loopback backend
    // (We need to use the backend directly since VirtualNetwork.connect parses address)
    listener.close();
    await net.close();
  });

  it('addBackend for custom scheme', async () => {
    const net = new VirtualNetwork();
    const customBackend = {
      connect: async () => { throw new Error('custom connect'); },
      listen: async () => { throw new Error('custom listen'); },
      sendDatagram: async () => {},
      bindDatagram: async () => {},
      resolve: async () => ['10.0.0.1'],
      close: async () => {},
    };
    net.addBackend('custom', customBackend);
    assert.ok(net.schemes.includes('custom'));

    await assert.rejects(
      () => net.connect('custom://host:80'),
      { message: 'custom connect' }
    );
    await net.close();
  });
});
