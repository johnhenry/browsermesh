// Run with: node --import ./test/_setup-globals.mjs --test test/issue-112-mutual-watch-broadcast-loop.test.mjs
//
// Regression test for https://github.com/johnhenry/browsermesh/issues/112
//
// `MeshSyncEngine.merge()` used to call `#notifySubscribers()` unconditionally,
// even when the merge was a value-level no-op (the remote payload's vector
// clock was already dominated by, or equal to, the local document's clock).
// Real callers -- `mesh-kv.mjs` and `manifest-sync.mjs` -- implement `watch()`
// by subscribing to `MeshSyncEngine` and re-broadcasting (via `queueMicrotask`)
// on every notification. With mutual `watch()` between two peers who have each
// authored entries, that meant: A merges B's state (no-op) -> A still notifies
// -> A re-broadcasts to B -> B merges A's state (no-op) -> B still notifies ->
// B re-broadcasts to A -> ... forever, with no timeout, starving the event
// loop entirely (the loop is driven by microtasks, which Node drains to
// completion before ever reaching a timer phase, so nothing -- not even
// `setTimeout` -- can interrupt it once it starts).
//
// This test reproduces the bug at the `MeshSyncEngine` level directly (not
// via the apps-layer example), simulating exactly the `watch()` wiring used
// by `mesh-kv.mjs`/`manifest-sync.mjs`: subscribe to the doc, and on every
// notification, broadcast the current payload to the other peer via
// `queueMicrotask`.
//
// A hard `BROADCAST_CAP` guards the harness itself so that a regression fails
// this test quickly instead of hanging the whole suite (and CI) forever --
// see the module doc comment above for why `setTimeout`-based timeouts alone
// cannot bound this failure mode.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MeshSyncEngine } from '../src/sync.mjs';

/**
 * Wire up mutual, mesh-kv-style `watch()`: subscribing to a doc and
 * re-broadcasting its current payload to the peer engine via queueMicrotask
 * whenever the local copy changes (from either a local write or an accepted
 * remote merge) -- mirroring `mesh-kv.mjs`'s `engine.subscribe(docId, () =>
 * syncWith(pubKey))` wiring exactly.
 *
 * @param {MeshSyncEngine} local
 * @param {MeshSyncEngine} remote
 * @param {string} docId
 * @param {{ count: number, cap: number }} counter  Shared broadcast counter/cap.
 * @returns {() => void} Unsubscribe function.
 */
function wireMutualWatch(local, remote, docId, counter) {
  return local.subscribe(docId, () => {
    queueMicrotask(() => {
      counter.count++;
      if (counter.count > counter.cap) return; // safety valve -- see module doc comment
      remote.merge(docId, local.prepareSyncPayload(docId));
    });
  });
}

/** Poll until `counter.count` stops changing, or `maxMs` elapses. */
async function waitForSettle(counter, maxMs) {
  const start = Date.now();
  let last = -1;
  while (Date.now() - start < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (counter.count === last) return Date.now() - start;
    last = counter.count;
  }
  throw new Error(`did not settle within ${maxMs}ms (broadcastCount=${counter.count})`);
}

describe('MeshSyncEngine mutual watch() broadcast loop (#112)', () => {
  it('two peers with mutual watch(), both authoring entries, converge promptly without an unbounded broadcast loop', async () => {
    const a = new MeshSyncEngine({ nodeId: 'nodeA' });
    const b = new MeshSyncEngine({ nodeId: 'nodeB' });
    a.create('doc', 'lww-map');
    b.create('doc', 'lww-map');

    // Cap generous relative to the handful of real merges this scenario
    // needs (a few), but tight enough that hitting it -- proving the loop
    // never settled on its own -- fails fast rather than hanging the runner.
    const counter = { count: 0, cap: 500 };
    const unsubA = wireMutualWatch(a, b, 'doc', counter);
    const unsubB = wireMutualWatch(b, a, 'doc', counter);

    const start = Date.now();

    // Both peers author distinct entries in the same doc -- the normal,
    // expected use case for bidirectional sync between two writers.
    a.update('doc', (crdt) => crdt.set('fromA', 'a-value', 1, 'nodeA'));
    b.update('doc', (crdt) => crdt.set('fromB', 'b-value', 1, 'nodeB'));

    const settleMs = await waitForSettle(counter, 2000);

    unsubA();
    unsubB();

    // Must actually converge -- suppressing the no-op-notify must not break
    // real propagation.
    assert.deepEqual(a.getState('doc'), { fromA: 'a-value', fromB: 'b-value' });
    assert.deepEqual(b.getState('doc'), { fromA: 'a-value', fromB: 'b-value' });

    // Must settle quickly (a real wall-clock bound), not merely "eventually".
    assert.ok(
      Date.now() - start < 500,
      `expected convergence well within 500ms, took ${Date.now() - start}ms`,
    );
    assert.ok(settleMs < 500, `expected settle detection within 500ms, took ${settleMs}ms`);

    // Must settle on a small, bounded number of real broadcasts -- not by
    // hitting the safety cap (which would indicate the loop never actually
    // stopped on its own).
    assert.ok(
      counter.count < counter.cap,
      `broadcast loop hit the safety cap (${counter.cap}) instead of settling naturally -- this is the #112 unbounded broadcast loop`,
    );
    assert.ok(
      counter.count <= 10,
      `expected a small, bounded number of real broadcasts to converge two new entries, got ${counter.count}`,
    );
  });
});
