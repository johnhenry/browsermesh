import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PriorityScheduler } from '../src/scheduler.mjs';

test('strict priority: highest non-empty tier always wins outside guard slots', () => {
  const s = new PriorityScheduler({ starvationGuardInterval: Infinity });
  s.enqueue('low', 'l1');
  s.enqueue('normal', 'n1');
  s.enqueue('high', 'h1');
  s.enqueue('high', 'h2');

  assert.equal(s.dequeue(), 'h1');
  assert.equal(s.dequeue(), 'h2');
  assert.equal(s.dequeue(), 'n1'); // high now empty -> normal wins
  assert.equal(s.dequeue(), 'l1'); // normal now empty -> low wins
  assert.equal(s.dequeue(), undefined); // all empty
});

test('same-tier items are served in strict FIFO order', () => {
  const s = new PriorityScheduler({ starvationGuardInterval: Infinity });
  s.enqueue('high', 'a');
  s.enqueue('high', 'b');
  s.enqueue('high', 'c');
  assert.equal(s.dequeue(), 'a');
  assert.equal(s.dequeue(), 'b');
  assert.equal(s.dequeue(), 'c');
});

test('anti-starvation guard forces the lowest non-empty tier on every Nth dequeue', () => {
  const INTERVAL = 4;
  const s = new PriorityScheduler({ starvationGuardInterval: INTERVAL });
  s.enqueue('low', 'low-item');
  // Keep 'high' permanently non-empty across the whole test.
  for (let i = 0; i < 20; i++) s.enqueue('high', `high-${i}`);

  const order = [];
  for (let i = 0; i < INTERVAL; i++) order.push(s.dequeue());

  // Slots 1..(INTERVAL-1) are strict priority -> all high (since high is
  // never empty). Slot INTERVAL is the guard slot -> forced to the lowest
  // non-empty tier, i.e. 'low', regardless of high's backlog.
  assert.deepEqual(order.slice(0, INTERVAL - 1), Array.from({ length: INTERVAL - 1 }, (_, i) => `high-${i}`));
  assert.equal(order[INTERVAL - 1], 'low-item');
});

test('guard slot prefers the lowest non-empty tier, skipping a mid tier that is empty', () => {
  const s = new PriorityScheduler({ tiers: ['high', 'normal', 'low'], starvationGuardInterval: 1 });
  s.enqueue('high', 'h');
  s.enqueue('low', 'l');
  // Every dequeue is a guard slot (interval=1) -> lowest non-empty tier
  // ('low') must win over 'high', even though 'normal' (in between) is empty.
  assert.equal(s.dequeue(), 'l');
  assert.equal(s.dequeue(), 'h');
});

test('bounded starvation: a lone low-priority item is served within starvationGuardInterval dequeues, no matter how large the high backlog is', () => {
  const INTERVAL = 8;
  const s = new PriorityScheduler({ starvationGuardInterval: INTERVAL });
  s.enqueue('low', 'the-low-item');
  for (let i = 0; i < 10_000; i++) s.enqueue('high', `flood-${i}`); // enormous high backlog

  let dequeuesUntilLow = 0;
  let found = null;
  for (let i = 1; i <= INTERVAL; i++) {
    dequeuesUntilLow = i;
    found = s.dequeue();
    if (found === 'the-low-item') break;
  }

  assert.equal(found, 'the-low-item');
  assert.ok(dequeuesUntilLow <= INTERVAL, `expected within ${INTERVAL} dequeues, took ${dequeuesUntilLow}`);
});

test('disabling the guard (Infinity) allows true starvation of the lowest tier', () => {
  const s = new PriorityScheduler({ starvationGuardInterval: Infinity });
  s.enqueue('low', 'l1');
  for (let i = 0; i < 50; i++) s.enqueue('high', `h${i}`);

  for (let i = 0; i < 50; i++) {
    assert.notEqual(s.dequeue(), 'l1'); // never served while high has backlog
  }
  assert.equal(s.dequeue(), 'l1'); // only served once high is finally empty
});

test('size and sizeOf report accurate queue depths', () => {
  const s = new PriorityScheduler();
  s.enqueue('high', 1);
  s.enqueue('high', 2);
  s.enqueue('low', 3);
  assert.equal(s.size, 3);
  assert.equal(s.sizeOf('high'), 2);
  assert.equal(s.sizeOf('low'), 1);
  assert.equal(s.sizeOf('normal'), 0);
  s.dequeue();
  assert.equal(s.size, 2);
});

test('constructor rejects an empty tier list and a sub-1 guard interval', () => {
  assert.throws(() => new PriorityScheduler({ tiers: [] }), /at least one tier/);
  assert.throws(() => new PriorityScheduler({ starvationGuardInterval: 0 }), /must be >= 1/);
});

test('enqueue rejects an unknown tier name', () => {
  const s = new PriorityScheduler();
  assert.throws(() => s.enqueue('urgent', 'x'), /unknown tier/);
});
