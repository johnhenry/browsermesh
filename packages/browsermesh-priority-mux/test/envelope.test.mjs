import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeEnvelope, decodeEnvelope } from '../src/envelope.mjs';

test('round-trips a UTF-8 string, including multi-byte characters', () => {
  const value = 'hello, mesh 🕸️ world';
  assert.equal(decodeEnvelope(encodeEnvelope(value)), value);
});

test('round-trips a plain JSON-serializable object', () => {
  const value = { type: 'ping', seq: 7, nested: { ok: true, list: [1, 2, 3] } };
  assert.deepEqual(decodeEnvelope(encodeEnvelope(value)), value);
});

test('round-trips raw Uint8Array bytes untouched', () => {
  const value = new Uint8Array([9, 8, 7, 6]);
  const decoded = decodeEnvelope(encodeEnvelope(value));
  assert.ok(decoded instanceof Uint8Array);
  assert.deepEqual([...decoded], [9, 8, 7, 6]);
});

test('round-trips a raw ArrayBuffer as bytes', () => {
  const buf = new ArrayBuffer(4);
  new Uint8Array(buf).set([1, 2, 3, 4]);
  const decoded = decodeEnvelope(encodeEnvelope(buf));
  assert.deepEqual([...decoded], [1, 2, 3, 4]);
});

test('empty string and empty object round-trip correctly', () => {
  assert.equal(decodeEnvelope(encodeEnvelope('')), '');
  assert.deepEqual(decodeEnvelope(encodeEnvelope({})), {});
});

test('decodeEnvelope rejects an empty buffer (no tag byte)', () => {
  assert.throws(() => decodeEnvelope(new Uint8Array(0)), /too short/);
});

test('decodeEnvelope rejects an unknown tag', () => {
  const bad = new Uint8Array([99, 1, 2, 3]);
  assert.throws(() => decodeEnvelope(bad), /unknown envelope tag/);
});
