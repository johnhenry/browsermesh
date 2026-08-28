import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OperationQueue } from '../src/queue.mjs';

describe('OperationQueue', () => {
  it('enqueue + drain', async () => {
    const queue = new OperationQueue();
    const p = queue.enqueue({ action: 'connect', host: 'localhost' });
    await queue.drain(async (op) => op.host);
    const result = await p;
    assert.equal(result, 'localhost');
  });

  it('FIFO order', async () => {
    const queue = new OperationQueue();
    const order = [];
    const p1 = queue.enqueue('first');
    const p2 = queue.enqueue('second');
    const p3 = queue.enqueue('third');
    await queue.drain(async (op) => {
      order.push(op);
      return op;
    });
    assert.deepEqual(order, ['first', 'second', 'third']);
    assert.equal(await p1, 'first');
    assert.equal(await p2, 'second');
    assert.equal(await p3, 'third');
  });

  it('full → QueueFullError', () => {
    const queue = new OperationQueue({ maxSize: 2 });
    queue.enqueue('a');
    queue.enqueue('b');
    assert.throws(() => queue.enqueue('c'), { name: 'QueueFullError' });
  });

  it('drain rejects on executeFn error', async () => {
    const queue = new OperationQueue();
    const p = queue.enqueue('fail');
    await queue.drain(async () => { throw new Error('boom'); });
    await assert.rejects(() => p, { message: 'boom' });
  });

  it('size tracking', () => {
    const queue = new OperationQueue();
    assert.equal(queue.size, 0);
    queue.enqueue('a');
    assert.equal(queue.size, 1);
    queue.enqueue('b');
    assert.equal(queue.size, 2);
  });

  it('drain empties the queue', async () => {
    const queue = new OperationQueue();
    queue.enqueue('a');
    queue.enqueue('b');
    assert.equal(queue.size, 2);
    await queue.drain(async (op) => op);
    assert.equal(queue.size, 0);
  });

  it('clear rejects pending', async () => {
    const queue = new OperationQueue();
    const p = queue.enqueue('a');
    queue.clear();
    await assert.rejects(() => p, /cleared/);
    assert.equal(queue.size, 0);
  });
});
