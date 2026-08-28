import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceRegistry } from '../src/service-registry.mjs';

describe('ServiceRegistry', () => {
  it('register and lookup', async () => {
    const reg = new ServiceRegistry();
    const handler = () => {};
    reg.register('echo', handler, { metadata: { version: '1.0' } });
    const entry = await reg.lookup('echo');
    assert.equal(entry.name, 'echo');
    assert.equal(entry.listener, handler);
    assert.equal(entry.metadata.version, '1.0');
  });

  it('register throws AlreadyRegisteredError for duplicate', () => {
    const reg = new ServiceRegistry();
    reg.register('echo', () => {});
    assert.throws(() => reg.register('echo', () => {}), { name: 'AlreadyRegisteredError' });
  });

  it('unregister removes service', async () => {
    const reg = new ServiceRegistry();
    reg.register('echo', () => {});
    reg.unregister('echo');
    assert.equal(reg.has('echo'), false);
    await assert.rejects(() => reg.lookup('echo'), { name: 'NotFoundError' });
  });

  it('unregister throws NotFoundError for missing', () => {
    const reg = new ServiceRegistry();
    assert.throws(() => reg.unregister('missing'), { name: 'NotFoundError' });
  });

  it('lookup throws NotFoundError for missing', async () => {
    const reg = new ServiceRegistry();
    await assert.rejects(() => reg.lookup('missing'), { name: 'NotFoundError' });
  });

  it('has returns true/false', () => {
    const reg = new ServiceRegistry();
    assert.equal(reg.has('echo'), false);
    reg.register('echo', () => {});
    assert.equal(reg.has('echo'), true);
  });

  it('list returns all names', () => {
    const reg = new ServiceRegistry();
    reg.register('a', () => {});
    reg.register('b', () => {});
    const names = reg.list();
    assert.ok(names.includes('a'));
    assert.ok(names.includes('b'));
    assert.equal(names.length, 2);
  });

  it('onRegister callback fires', () => {
    const reg = new ServiceRegistry();
    const events = [];
    reg.onRegister(entry => events.push(entry.name));
    reg.register('echo', () => {});
    assert.deepEqual(events, ['echo']);
  });

  it('onUnregister callback fires', () => {
    const reg = new ServiceRegistry();
    const events = [];
    reg.onUnregister(entry => events.push(entry.name));
    reg.register('echo', () => {});
    reg.unregister('echo');
    assert.deepEqual(events, ['echo']);
  });

  it('onLookupMiss hook resolves remote service', async () => {
    const reg = new ServiceRegistry();
    reg.onLookupMiss(async (name) => {
      if (name === 'remote-svc') return { name, listener: null, metadata: { remote: true }, owner: 'node_2' };
      return null;
    });
    const entry = await reg.lookup('remote-svc');
    assert.equal(entry.name, 'remote-svc');
    assert.equal(entry.metadata.remote, true);
  });

  it('registerRemote', async () => {
    const reg = new ServiceRegistry();
    reg.registerRemote('fs', 'node_3', { path: '/data' });
    const entry = await reg.lookup('fs');
    assert.equal(entry.metadata.remote, true);
    assert.equal(entry.metadata.nodeId, 'node_3');
  });

  it('clear removes everything', () => {
    const reg = new ServiceRegistry();
    reg.register('a', () => {});
    reg.register('b', () => {});
    reg.clear();
    assert.equal(reg.list().length, 0);
  });
});
