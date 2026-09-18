import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeChunkFrame, decodeChunkFrame, splitIntoChunks, PRIORITY_CODES } from '../src/frame.mjs';

test('encodeChunkFrame/decodeChunkFrame round-trips all fields', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const frame = encodeChunkFrame({ priority: 'high', msgId: 42, seq: 1, total: 3, payload });
  const decoded = decodeChunkFrame(frame);
  assert.equal(decoded.priority, 'high');
  assert.equal(decoded.msgId, 42);
  assert.equal(decoded.seq, 1);
  assert.equal(decoded.total, 3);
  assert.deepEqual([...decoded.payload], [1, 2, 3, 4, 5]);
});

test('frame header is exactly 14 bytes before the payload', () => {
  const frame = encodeChunkFrame({ priority: 'normal', msgId: 0, seq: 0, total: 1, payload: new Uint8Array(0) });
  assert.equal(frame.byteLength, 14);
});

test('encodeChunkFrame handles a missing payload as zero-length', () => {
  const frame = encodeChunkFrame({ priority: 'low', msgId: 1, seq: 0, total: 1 });
  const decoded = decodeChunkFrame(frame);
  assert.equal(decoded.payload.byteLength, 0);
});

test('all three priority tiers round-trip through their wire codes', () => {
  for (const priority of Object.keys(PRIORITY_CODES)) {
    const frame = encodeChunkFrame({ priority, msgId: 1, seq: 0, total: 1, payload: new Uint8Array(0) });
    assert.equal(decodeChunkFrame(frame).priority, priority);
  }
});

test('decodeChunkFrame rejects a truncated frame', () => {
  assert.throws(() => decodeChunkFrame(new Uint8Array(5)), /too short/);
});

test('decodeChunkFrame rejects an unsupported version byte', () => {
  const frame = encodeChunkFrame({ priority: 'high', msgId: 0, seq: 0, total: 1, payload: new Uint8Array(0) });
  frame[0] = 99; // corrupt version
  assert.throws(() => decodeChunkFrame(frame), /unsupported frame version/);
});

test('decodeChunkFrame rejects an unknown priority code', () => {
  const frame = encodeChunkFrame({ priority: 'high', msgId: 0, seq: 0, total: 1, payload: new Uint8Array(0) });
  frame[1] = 200; // corrupt priority code
  assert.throws(() => decodeChunkFrame(frame), /unknown priority code/);
});

test('encodeChunkFrame rejects an unknown priority tier name', () => {
  assert.throws(
    () => encodeChunkFrame({ priority: 'urgent', msgId: 0, seq: 0, total: 1, payload: new Uint8Array(0) }),
    /unknown priority tier/,
  );
});

test('splitIntoChunks splits evenly-divisible input into exact chunk counts', () => {
  const bytes = new Uint8Array(30).map((_, i) => i);
  const chunks = splitIntoChunks(bytes, 10);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.payload.byteLength), [10, 10, 10]);
  assert.deepEqual([...chunks[0].payload], [...bytes.subarray(0, 10)]);
  assert.deepEqual([...chunks[2].payload], [...bytes.subarray(20, 30)]);
});

test('splitIntoChunks handles a remainder chunk smaller than chunkSize', () => {
  const bytes = new Uint8Array(25);
  const chunks = splitIntoChunks(bytes, 10);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[2].payload.byteLength, 5);
});

test('splitIntoChunks always produces at least one chunk, even for empty input', () => {
  const chunks = splitIntoChunks(new Uint8Array(0), 10);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].total, 1);
  assert.equal(chunks[0].payload.byteLength, 0);
});

test('splitIntoChunks stamps every chunk with a consistent seq/total', () => {
  const bytes = new Uint8Array(45);
  const chunks = splitIntoChunks(bytes, 10);
  chunks.forEach((c, i) => {
    assert.equal(c.seq, i);
    assert.equal(c.total, chunks.length);
  });
});
