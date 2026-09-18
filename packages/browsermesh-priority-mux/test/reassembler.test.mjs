import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reassembler } from '../src/reassembler.mjs';

function chunk(msgId, seq, total, bytes) {
  return { priority: 'normal', msgId, seq, total, payload: new Uint8Array(bytes) };
}

test('reassembles in-order chunks into the original byte sequence', () => {
  const r = new Reassembler();
  assert.equal(r.receive(chunk(1, 0, 3, [1, 2])), undefined);
  assert.equal(r.receive(chunk(1, 1, 3, [3, 4])), undefined);
  const result = r.receive(chunk(1, 2, 3, [5]));
  assert.deepEqual([...result.bytes], [1, 2, 3, 4, 5]);
  assert.equal(result.msgId, 1);
});

test('reassembles out-of-order chunks correctly (arrival order must not matter)', () => {
  const r = new Reassembler();
  assert.equal(r.receive(chunk(2, 2, 3, [5, 6])), undefined);
  assert.equal(r.receive(chunk(2, 0, 3, [1, 2])), undefined);
  const result = r.receive(chunk(2, 1, 3, [3, 4]));
  assert.deepEqual([...result.bytes], [1, 2, 3, 4, 5, 6]);
});

test('a message never fires complete until every chunk has arrived', () => {
  const r = new Reassembler();
  assert.equal(r.receive(chunk(3, 0, 4, [1])), undefined);
  assert.equal(r.receive(chunk(3, 1, 4, [2])), undefined);
  assert.equal(r.receive(chunk(3, 2, 4, [3])), undefined);
  assert.equal(r.pendingCount, 1);
  const result = r.receive(chunk(3, 3, 4, [4]));
  assert.ok(result);
  assert.equal(r.pendingCount, 0);
});

test('adversarial interleaving: multiple concurrent messages reassemble independently and correctly', () => {
  const r = new Reassembler();
  const msgA = [chunk('A', 0, 3, [1]), chunk('A', 1, 3, [2]), chunk('A', 2, 3, [3])];
  const msgB = [chunk('B', 0, 2, [9, 9]), chunk('B', 1, 2, [8, 8])];
  const msgC = [chunk('C', 0, 4, [0]), chunk('C', 1, 4, [1]), chunk('C', 2, 4, [2]), chunk('C', 3, 4, [3])];

  // Scramble the delivery order across all three in-flight messages.
  const interleaved = [msgA[1], msgB[0], msgC[2], msgA[0], msgC[0], msgB[1], msgC[3], msgA[2], msgC[1]];

  const completed = {};
  for (const c of interleaved) {
    const result = r.receive(c);
    if (result) completed[result.msgId] = result.bytes;
  }

  assert.deepEqual([...completed.A], [1, 2, 3]);
  assert.deepEqual([...completed.B], [9, 9, 8, 8]);
  assert.deepEqual([...completed.C], [0, 1, 2, 3]);
  assert.equal(r.pendingCount, 0);
});

test('duplicate chunk delivery is a no-op, not a double count', () => {
  const r = new Reassembler();
  r.receive(chunk(5, 0, 2, [1]));
  r.receive(chunk(5, 0, 2, [1])); // duplicate of seq 0
  const result = r.receive(chunk(5, 1, 2, [2]));
  assert.ok(result); // still completes correctly, not stuck expecting a 3rd chunk
  assert.deepEqual([...result.bytes], [1, 2]);
});

test('rejects an out-of-range seq', () => {
  const r = new Reassembler();
  assert.throws(() => r.receive(chunk(6, 5, 3, [1])), /out of range/);
});

test('rejects a total that disagrees with an already-pending msgId', () => {
  const r = new Reassembler();
  r.receive(chunk(7, 0, 3, [1]));
  assert.throws(() => r.receive(chunk(7, 1, 5, [2])), /total mismatch/);
});

test('reset() discards all pending reassembly state (e.g. on transport close)', () => {
  const r = new Reassembler();
  r.receive(chunk(8, 0, 3, [1]));
  r.receive(chunk(9, 0, 2, [1]));
  assert.equal(r.pendingCount, 2);
  r.reset();
  assert.equal(r.pendingCount, 0);
  // A late-arriving chunk for a reset msgId starts a fresh entry rather
  // than resurrecting stale state or throwing.
  const result = r.receive(chunk(8, 0, 1, [42]));
  assert.ok(result);
  assert.deepEqual([...result.bytes], [42]);
});
