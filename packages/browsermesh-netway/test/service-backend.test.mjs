import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceBackend } from '../src/service-backend.mjs';
import { ServiceRegistry } from './_stubs/service-registry.mjs';

describe('ServiceBackend', () => {
  it('connect to registered service with handleConnection', async () => {
    const registry = new ServiceRegistry();
    const connections = [];
    registry.register('echo', {
      handleConnection(socket) { connections.push(socket); },
    });

    const backend = new ServiceBackend(registry);
    const clientSocket = await backend.connect('echo');

    assert.equal(connections.length, 1);

    // Data flows between client and service
    const data = new Uint8Array([1, 2, 3]);
    await clientSocket.write(data);
    const received = await connections[0].read();
    assert.deepEqual(received, data);

    await clientSocket.close();
    await connections[0].close();
  });

  it('connect to registered service with enqueue', async () => {
    const registry = new ServiceRegistry();
    const queue = [];
    registry.register('queue-svc', {
      enqueue(socket) { queue.push(socket); },
    });

    const backend = new ServiceBackend(registry);
    const clientSocket = await backend.connect('queue-svc');

    assert.equal(queue.length, 1);
    await clientSocket.close();
    await queue[0].close();
  });

  it('connect throws ConnectionRefusedError for missing service', async () => {
    const registry = new ServiceRegistry();
    const backend = new ServiceBackend(registry);
    await assert.rejects(() => backend.connect('missing'), { name: 'ConnectionRefusedError' });
  });

  it('connect throws ConnectionRefusedError for null listener', async () => {
    const registry = new ServiceRegistry();
    registry.register('null-svc', null);
    const backend = new ServiceBackend(registry);
    await assert.rejects(() => backend.connect('null-svc'), { name: 'ConnectionRefusedError' });
  });
});
