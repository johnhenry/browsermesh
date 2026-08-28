import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KernelMessagePort, createChannel } from '../src/message-port.mjs';

describe('KernelMessagePort', () => {
  it('post on closed port throws StreamClosedError', () => {
    const [a, b] = createChannel();
    a.close();
    assert.throws(() => a.post('hello'), { name: 'StreamClosedError' });
    b.close();
  });

  it('closed property', () => {
    const [a, b] = createChannel();
    assert.equal(a.closed, false);
    a.close();
    assert.equal(a.closed, true);
    b.close();
  });
});

describe('createChannel', () => {
  it('message from A arrives at B', async () => {
    const [a, b] = createChannel();
    const received = [];
    b.onMessage(msg => received.push(msg));
    a.post('hello');
    await flush();
    assert.deepEqual(received, ['hello']);
    a.close();
    b.close();
  });

  it('message from B arrives at A', async () => {
    const [a, b] = createChannel();
    const received = [];
    a.onMessage(msg => received.push(msg));
    b.post('world');
    await flush();
    assert.deepEqual(received, ['world']);
    a.close();
    b.close();
  });

  it('FIFO ordering', async () => {
    const [a, b] = createChannel();
    const received = [];
    b.onMessage(msg => received.push(msg));
    a.post(1);
    a.post(2);
    a.post(3);
    await flush();
    assert.deepEqual(received, [1, 2, 3]);
    a.close();
    b.close();
  });

  it('multiple listeners', async () => {
    const [a, b] = createChannel();
    const r1 = [], r2 = [];
    b.onMessage(msg => r1.push(msg));
    b.onMessage(msg => r2.push(msg));
    a.post('x');
    await flush();
    assert.deepEqual(r1, ['x']);
    assert.deepEqual(r2, ['x']);
    a.close();
    b.close();
  });

  it('unsubscribe removes listener', async () => {
    const [a, b] = createChannel();
    const received = [];
    const unsub = b.onMessage(msg => received.push(msg));
    a.post(1);
    await flush();
    unsub();
    a.post(2);
    await flush();
    assert.deepEqual(received, [1]);
    a.close();
    b.close();
  });

  it('post to closed peer is silent', async () => {
    const [a, b] = createChannel();
    b.close();
    // Should not throw — just silently drop
    a.post('gone');
    await flush();
    a.close();
  });
});

function flush() {
  return new Promise(resolve => setTimeout(resolve, 10));
}
