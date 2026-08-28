import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualNetwork } from '../src/virtual-network.mjs';
import { CAPABILITY } from '../src/constants.mjs';

describe('VirtualNetwork', () => {
  it('default loopback works', async () => {
    const net = new VirtualNetwork();
    const listener = await net.listen('mem://localhost:8080');
    const client = await net.connect('mem://localhost:8080');
    const server = await listener.accept();

    await client.write(new Uint8Array([10, 20]));
    const data = await server.read();
    assert.deepEqual(data, new Uint8Array([10, 20]));

    await client.close();
    await server.close();
    listener.close();
    await net.close();
  });

  it('loop:// scheme works', async () => {
    const net = new VirtualNetwork();
    const listener = await net.listen('loop://localhost:9090');
    const client = await net.connect('loop://localhost:9090');
    const server = await listener.accept();

    await server.write(new Uint8Array([99]));
    const data = await client.read();
    assert.deepEqual(data, new Uint8Array([99]));

    await client.close();
    await server.close();
    listener.close();
    await net.close();
  });

  it('tcp:// fails with no gateway backend', async () => {
    const net = new VirtualNetwork();
    await assert.rejects(
      () => net.connect('tcp://example.com:80'),
      { name: 'UnknownSchemeError' }
    );
    await net.close();
  });

  it('resolve returns 127.0.0.1 from loopback', async () => {
    const net = new VirtualNetwork();
    const result = await net.resolve('anything');
    assert.deepEqual(result, ['127.0.0.1']);
    await net.close();
  });

  it('schemes lists registered schemes', () => {
    const net = new VirtualNetwork();
    assert.ok(net.schemes.includes('mem'));
    assert.ok(net.schemes.includes('loop'));
  });

  it('UDP via loopback', async () => {
    const net = new VirtualNetwork();
    const socket = await net.bindDatagram('mem://localhost:5353');

    const received = [];
    socket.onMessage((from, data) => received.push({ from, data }));

    await net.sendDatagram('mem://localhost:5353', new Uint8Array([0xCA, 0xFE]));
    assert.equal(received.length, 1);
    assert.deepEqual(received[0].data, new Uint8Array([0xCA, 0xFE]));

    socket.close();
    await net.close();
  });
});

describe('ScopedNetwork', () => {
  it('allows with matching capability', async () => {
    const net = new VirtualNetwork();
    const scoped = net.scope({ capabilities: [CAPABILITY.LOOPBACK] });

    const listener = await scoped.listen('mem://localhost:3000');
    const client = await scoped.connect('mem://localhost:3000');
    const server = await listener.accept();

    await client.write(new Uint8Array([1]));
    const data = await server.read();
    assert.deepEqual(data, new Uint8Array([1]));

    await client.close();
    await server.close();
    listener.close();
    await net.close();
  });

  it('denies without matching capability', async () => {
    const net = new VirtualNetwork();
    const scoped = net.scope({ capabilities: [] });

    await assert.rejects(
      () => scoped.connect('mem://localhost:3000'),
      { name: 'PolicyDeniedError' }
    );
    await net.close();
  });

  it('wildcard allows all', async () => {
    const net = new VirtualNetwork();
    const scoped = net.scope({ capabilities: [CAPABILITY.ALL] });

    const listener = await scoped.listen('mem://localhost:4000');
    listener.close();
    await net.close();
  });

  it('custom policy callback', async () => {
    const net = new VirtualNetwork();
    const scoped = net.scope({
      capabilities: [CAPABILITY.LOOPBACK],
      policy: (request, tags) => {
        // Deny port 6666
        if (request.address?.includes(':6666')) return 'deny';
        return tags.has(request.capability) ? 'allow' : 'deny';
      },
    });

    // Allowed port
    const listener = await scoped.listen('mem://localhost:5000');
    listener.close();

    // Denied port
    await assert.rejects(
      () => scoped.listen('mem://localhost:6666'),
      { name: 'PolicyDeniedError' }
    );

    await net.close();
  });

  it('close shuts all backends', async () => {
    const net = new VirtualNetwork();
    const listener = await net.listen('mem://localhost:7000');
    await net.close();
    // Listener was closed by backend.close()
    await assert.rejects(
      () => net.connect('mem://localhost:7000'),
      { name: 'ConnectionRefusedError' }
    );
  });
});
