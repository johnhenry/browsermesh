import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PriorityMux } from '../src/priority-mux.mjs';
import { decodeChunkFrame, encodeChunkFrame } from '../src/frame.mjs';
import { encodeEnvelope } from '../src/envelope.mjs';
import { FakeAdapter, pairFakeAdapters } from './_fake-adapter.mjs';

/** Wait until `predicate()` is truthy, polling on real macrotask ticks. */
function waitUntil(predicate, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitUntil: timed out'));
      setImmediate(check);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// (a) Head-of-line blocking avoidance, with real timing/ordering evidence
// ---------------------------------------------------------------------------

test('a chunked low-priority message does not block several small high-priority messages, proven with real arrival timestamps', async () => {
  const [senderAdapter, receiverAdapter] = pairFakeAdapters();
  const sender = new PriorityMux(senderAdapter, { chunkSize: 20 });
  const receiver = new PriorityMux(receiverAdapter, { chunkSize: 20 });

  const arrivals = []; // { kind, t }
  receiver.on('message', (value) => {
    arrivals.push({ kind: value.kind, n: value.n, t: performance.now() });
  });

  // One big low-priority message: 20-byte chunks over ~1000 bytes -> ~50 chunks.
  const bigPayload = { kind: 'bulk', n: 0, blob: 'x'.repeat(1000) };
  const { total: bulkTotal } = sender.send(bigPayload, { priority: 'low' });
  assert.ok(bulkTotal >= 40, `expected the bulk message to need many chunks, got ${bulkTotal}`);

  // Queued immediately after, in the same tick -- before any chunk has
  // actually been drained yet -- five small, urgent messages.
  const HIGH_COUNT = 5;
  for (let n = 0; n < HIGH_COUNT; n++) {
    sender.send({ kind: 'urgent', n }, { priority: 'high' });
  }

  await waitUntil(() => arrivals.length === HIGH_COUNT + 1);

  const highArrivals = arrivals.filter((a) => a.kind === 'urgent');
  const bulkArrival = arrivals.find((a) => a.kind === 'bulk');
  assert.equal(highArrivals.length, HIGH_COUNT);
  assert.ok(bulkArrival);

  // Real evidence #1: every high-priority message was fully reassembled
  // and delivered strictly before the bulk message, by arrival order.
  const bulkIndex = arrivals.indexOf(bulkArrival);
  assert.equal(bulkIndex, HIGH_COUNT, 'the bulk message must be the LAST of the 6 to arrive');

  // Real evidence #2: real wall-clock timestamps back this up too -- every
  // high-priority arrival happened at or before the bulk arrival's timestamp.
  for (const h of highArrivals) {
    assert.ok(h.t <= bulkArrival.t, `high-priority message n=${h.n} arrived after the bulk message`);
  }

  // Sanity: the high messages also arrived in the order they were sent
  // (same-tier FIFO), and their content survived chunk-free single-frame
  // transit intact.
  assert.deepEqual(highArrivals.map((a) => a.n), [0, 1, 2, 3, 4]);
});

// ---------------------------------------------------------------------------
// (b) Anti-starvation under a genuinely continuous high-priority flood
// ---------------------------------------------------------------------------

test('a queued low-priority message completes within a bounded number of drain cycles despite a continuous high-priority flood', async () => {
  const STARVATION_INTERVAL = 5;
  const adapter = new FakeAdapter();

  let sendCount = 0;
  const sentFrames = [];
  const rawSend = adapter.send.bind(adapter);
  adapter.send = (bytes) => {
    sendCount += 1;
    sentFrames.push({ atSend: sendCount, frame: decodeChunkFrame(bytes) });
    rawSend(bytes);
  };

  let floodActive = true;
  let floodN = 0;
  // scheduleFn is invoked once per drain slot, right before that slot's
  // work runs. Enqueuing another high-priority send from inside it means
  // the high tier is *never* empty for the scheduler to observe -- a real,
  // continuous flood tied to the scheduler's own cadence, not a one-shot
  // pile of pre-queued messages.
  const scheduleFn = (fn) => {
    if (floodActive) mux.send({ kind: 'flood', n: floodN++ }, { priority: 'high' });
    setImmediate(fn);
  };

  const mux = new PriorityMux(adapter, {
    chunkSize: 10,
    starvationGuardInterval: STARVATION_INTERVAL,
    scheduleFn,
  });

  const lowPayload = new Uint8Array(25).fill(7); // 25 bytes / 10-byte chunks = 3 chunks
  const { msgId: lowMsgId, total: lowTotal } = mux.send(lowPayload, { priority: 'low' });
  assert.equal(lowTotal, 3);

  await waitUntil(() => sentFrames.some(
    (f) => f.frame.msgId === lowMsgId && f.frame.priority === 'low' && f.frame.seq === lowTotal - 1,
  ));
  floodActive = false;

  const completionSlot = sentFrames.find(
    (f) => f.frame.msgId === lowMsgId && f.frame.priority === 'low' && f.frame.seq === lowTotal - 1,
  ).atSend;

  // Real bound: with one guard slot reserved every STARVATION_INTERVAL
  // drain cycles for the lowest non-empty tier, all 3 low chunks must be
  // sent by the 3rd guard slot at the very latest -- regardless of how
  // large the concurrent high-priority backlog is.
  const bound = STARVATION_INTERVAL * lowTotal;
  assert.ok(
    completionSlot <= bound,
    `expected the low message to finish within ${bound} drain cycles, took ${completionSlot}`,
  );

  // Prove the flood was real, not vacuous: many more high-priority chunks
  // were sent than low ones by the time the low message finished.
  const highSentBeforeCompletion = sentFrames.filter(
    (f) => f.atSend <= completionSlot && f.frame.priority === 'high',
  ).length;
  assert.ok(
    highSentBeforeCompletion >= completionSlot - lowTotal,
    `expected the high flood to dominate traffic up to slot ${completionSlot}, only saw ${highSentBeforeCompletion} high sends`,
  );
  assert.ok(highSentBeforeCompletion > 0);
});

// ---------------------------------------------------------------------------
// (c) Reassembly correctness under adversarial interleaving of multiple
//     large in-flight messages, fed directly and out of order
// ---------------------------------------------------------------------------

test('reassembles multiple large messages correctly when their chunks arrive interleaved and scrambled', async () => {
  const adapter = new FakeAdapter();
  const mux = new PriorityMux(adapter, { chunkSize: 8 });

  const received = [];
  mux.on('message', (value, meta) => received.push({ value, meta }));

  function frameChunksFor(msgId, priority, text) {
    const envelopeBytes = encodeEnvelope(text);
    const chunkSize = 8;
    const total = Math.max(1, Math.ceil(envelopeBytes.byteLength / chunkSize));
    const frames = [];
    for (let seq = 0; seq < total; seq++) {
      const payload = envelopeBytes.subarray(seq * chunkSize, (seq + 1) * chunkSize);
      frames.push(encodeChunkFrame({ priority, msgId, seq, total, payload }));
    }
    return frames;
  }

  const msgA = frameChunksFor(101, 'high', 'the quick brown fox jumps over the lazy dog');
  const msgB = frameChunksFor(202, 'low', 'a much longer bulk payload that spans many more chunks than the others here');
  const msgC = frameChunksFor(303, 'normal', 'medium sized message content');

  // Scramble delivery across all three messages AND scramble each
  // message's own chunk order -- simulating out-of-order arrival, not
  // just cross-message interleaving.
  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(((i + 7) * 2654435761) % (i + 1)); // deterministic, not Math.random
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const allFrames = shuffle([...shuffle(msgA), ...shuffle(msgB), ...shuffle(msgC)]);
  for (const frame of allFrames) adapter._deliver(frame);

  assert.equal(received.length, 3, 'each original message must fire exactly one message event, never partially');

  const byMsgId = Object.fromEntries(received.map((r) => [r.meta.msgId, r]));
  assert.equal(byMsgId[101].value, 'the quick brown fox jumps over the lazy dog');
  assert.equal(byMsgId[101].meta.priority, 'high');
  assert.equal(byMsgId[202].value, 'a much longer bulk payload that spans many more chunks than the others here');
  assert.equal(byMsgId[202].meta.priority, 'low');
  assert.equal(byMsgId[303].value, 'medium sized message content');
  assert.equal(byMsgId[303].meta.priority, 'normal');
});

// ---------------------------------------------------------------------------
// (d) Closing mid-flight must not hang or leave corrupted reassembly state
// ---------------------------------------------------------------------------

test('closing the underlying adapter mid-flight discards pending reassembly state without hanging', async () => {
  const [senderAdapter, receiverAdapter] = pairFakeAdapters();
  const sender = new PriorityMux(senderAdapter, { chunkSize: 5 });
  const receiver = new PriorityMux(receiverAdapter, { chunkSize: 5 });

  const messages = [];
  const closes = [];
  receiver.on('message', (v) => messages.push(v));
  receiver.on('close', () => closes.push(Date.now()));

  // A message that will need many chunks -- guaranteed to still be
  // mid-flight when we close a few ticks later.
  sender.send('x'.repeat(500), { priority: 'normal' });

  // Let a few chunks arrive, then sever the connection before completion.
  await waitUntil(() => receiverAdapter.outbox.length === 0 && senderAdapter.outbox.length >= 3);
  receiverAdapter.close();

  await waitUntil(() => closes.length === 1);

  assert.equal(messages.length, 0, 'the partially-delivered message must never fire as a complete message');
  assert.equal(receiver.getStats().pendingReassembly, 0, 'reassembly state must be discarded on close, not left hanging');

  // Sending after close must fail loudly, not silently hang or throw from
  // deep inside the drain loop.
  assert.throws(() => receiver.send('too late'), /closed/);
});

// ---------------------------------------------------------------------------
// (e) Caller-supplied priority classifier + explicit override
// ---------------------------------------------------------------------------

test('priorityOf classifies messages automatically, and an explicit send() option overrides it', () => {
  const adapter = new FakeAdapter();
  const priorityOf = (data) => {
    if (data && data.type === 'ping') return 'high';
    if (data && data.type === 'file-chunk') return 'low';
    return undefined; // fall through to defaultPriority
  };
  const mux = new PriorityMux(adapter, { priorityOf });

  assert.equal(mux.send({ type: 'ping' }).priority, 'high');
  assert.equal(mux.send({ type: 'file-chunk' }).priority, 'low');
  assert.equal(mux.send({ type: 'chit-chat' }).priority, 'normal'); // defaultPriority
  assert.equal(mux.send({ type: 'file-chunk' }, { priority: 'high' }).priority, 'high'); // explicit override wins
});

// ---------------------------------------------------------------------------
// (f) Transparency: callers get back what they sent
// ---------------------------------------------------------------------------

test('reassembled messages are handed back in their original shape (string, object, or bytes)', async () => {
  const [senderAdapter, receiverAdapter] = pairFakeAdapters();
  const sender = new PriorityMux(senderAdapter, { chunkSize: 4 });
  const receiver = new PriorityMux(receiverAdapter, { chunkSize: 4 });

  const received = [];
  receiver.on('message', (v) => received.push(v));

  sender.send('a plain string');
  sender.send({ an: 'object', with: [1, 2, 3] });
  sender.send(new Uint8Array([10, 20, 30]));

  await waitUntil(() => received.length === 3);

  assert.equal(received[0], 'a plain string');
  assert.deepEqual(received[1], { an: 'object', with: [1, 2, 3] });
  assert.ok(received[2] instanceof Uint8Array);
  assert.deepEqual([...received[2]], [10, 20, 30]);
});

test('constructor rejects an adapter missing send()/on()', () => {
  assert.throws(() => new PriorityMux({}), /must have send\(\) and on\(\)/);
});

test('send() rejects an unknown priority tier', () => {
  const mux = new PriorityMux(new FakeAdapter());
  assert.throws(() => mux.send('x', { priority: 'urgent' }), /unknown priority tier/);
});
