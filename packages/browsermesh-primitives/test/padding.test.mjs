import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PAD_BUCKETS,
  PAD_TRAILER_BYTES,
  paddedLength,
  padTo,
  unpad,
} from '../src/padding.mjs';
import * as pkg from '../src/index.mjs';

const bytes = (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 1) & 0xff);

describe('padTo / unpad (#191)', () => {
  it('is exported from the package index', () => {
    assert.equal(pkg.padTo, padTo);
    assert.equal(pkg.unpad, unpad);
    assert.equal(pkg.paddedLength, paddedLength);
  });

  it('pads to the next default bucket and round-trips', () => {
    for (const [n, expected] of [[0, 256], [1, 256], [252, 256], [253, 1024], [1020, 1024], [1021, 4096], [4092, 4096], [4093, 16384], [16380, 16384]]) {
      const padded = padTo(bytes(n));
      assert.equal(padded.length, expected, `payload of ${n} bytes`);
      assert.deepEqual(unpad(padded), bytes(n));
    }
  });

  it('a payload that exactly fills a bucket minus the trailer stays in that bucket', () => {
    assert.equal(padTo(bytes(256 - PAD_TRAILER_BYTES)).length, 256);
    assert.equal(padTo(bytes(256 - PAD_TRAILER_BYTES + 1)).length, 1024);
  });

  it('oversize payloads pad to a multiple of the largest bucket', () => {
    const largest = DEFAULT_PAD_BUCKETS[DEFAULT_PAD_BUCKETS.length - 1];
    const padded = padTo(bytes(largest + 10));
    assert.equal(padded.length, largest * 2);
    assert.deepEqual(unpad(padded), bytes(largest + 10));
    assert.equal(padTo(bytes(largest * 2 - 3)).length, largest * 3);
  });

  it('honours custom buckets (unsorted, duplicated) and does not mutate the input', () => {
    const buckets = [512, 64, 64];
    const input = bytes(60);
    const before = input.slice();
    assert.equal(padTo(input, { buckets }).length, 64);
    assert.equal(padTo(bytes(61), { buckets }).length, 512);
    assert.deepEqual(input, before);
    assert.deepEqual(buckets, [512, 64, 64]);
  });

  it('paddedLength agrees with padTo', () => {
    for (const n of [0, 10, 300, 5000, 40000]) {
      assert.equal(paddedLength(n), padTo(bytes(n)).length);
    }
  });

  it('fills with random bytes, not zeros', () => {
    const padded = padTo(bytes(1));
    const fill = padded.subarray(1, padded.length - PAD_TRAILER_BYTES);
    assert.ok(fill.some((b) => b !== 0));
  });

  it('handles fills larger than one getRandomValues call (64 KiB)', () => {
    const padded = padTo(bytes(5), { buckets: [200000] });
    assert.equal(padded.length, 200000);
    assert.deepEqual(unpad(padded), bytes(5));
  });

  it('unpad works on a view with a non-zero byteOffset', () => {
    const padded = padTo(bytes(20));
    const backing = new Uint8Array(padded.length + 8);
    backing.set(padded, 8);
    assert.deepEqual(unpad(backing.subarray(8)), bytes(20));
  });

  it('unpad rejects malformed input', () => {
    assert.throws(() => unpad(new Uint8Array(2)), RangeError);
    const bad = new Uint8Array(16);
    new DataView(bad.buffer).setUint32(12, 999, false);
    assert.throws(() => unpad(bad), RangeError);
    assert.throws(() => unpad('nope'), TypeError);
  });

  it('padTo rejects bad arguments', () => {
    assert.throws(() => padTo('str'), TypeError);
    assert.throws(() => padTo(bytes(1), { buckets: [] }), TypeError);
    assert.throws(() => padTo(bytes(1), { buckets: [4] }), TypeError);
    assert.throws(() => padTo(bytes(1), { buckets: [1.5, 100] }), TypeError);
  });

  it('negative control: unpadded lengths differ, padded lengths collapse to buckets', () => {
    const lengths = [3, 17, 90, 140, 200, 240];
    assert.equal(new Set(lengths).size, lengths.length);
    assert.deepEqual([...new Set(lengths.map((n) => padTo(bytes(n)).length))], [256]);
  });
});
