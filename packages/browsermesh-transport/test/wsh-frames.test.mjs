// Run with: node --import ./test/_setup-globals.mjs --test test/wsh-frames.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FRAME_KIND_BINARY,
  FRAME_KIND_TEXT,
  DEFAULT_MAX_FRAME_BYTES,
  encodeFrame,
  FrameDecoder,
  WshFrameError,
} from '../src/wsh-frames.mjs';

const enc = new TextEncoder();

describe('wsh frames: encode', () => {
  it('prefixes a big-endian length that counts the kind byte', () => {
    const f = encodeFrame('hi');
    assert.deepEqual([...f.subarray(0, 4)], [0, 0, 0, 3]);
    assert.equal(f[4], FRAME_KIND_TEXT);
    assert.equal(new TextDecoder().decode(f.subarray(5)), 'hi');
  });

  it('sends binary as kind 0 and objects as JSON text', () => {
    const b = encodeFrame(new Uint8Array([1, 2, 3]));
    assert.equal(b[4], FRAME_KIND_BINARY);
    const o = encodeFrame({ a: 1 });
    assert.equal(o[4], FRAME_KIND_TEXT);
    assert.equal(new TextDecoder().decode(o.subarray(5)), '{"a":1}');
  });

  it('refuses a frame over the limit locally, with a stable code', () => {
    assert.throws(() => encodeFrame(new Uint8Array(100), { maxFrameBytes: 50 }), (e) => e instanceof WshFrameError && e.code === 'WSH_FRAME_TOO_LARGE');
  });

  it('refuses values the wire cannot carry rather than sending "undefined"', () => {
    assert.throws(() => encodeFrame(undefined), TypeError);
    assert.throws(() => encodeFrame(() => {}), TypeError);
  });

  it('has a default limit of 1 MiB', () => {
    assert.equal(DEFAULT_MAX_FRAME_BYTES, 1024 * 1024);
  });
});

describe('wsh frames: decode', () => {
  it('round-trips text and binary, in order', () => {
    const d = new FrameDecoder();
    const out = [
      ...d.push(encodeFrame('one')),
      ...d.push(encodeFrame(new Uint8Array([9, 8, 7]))),
    ];
    assert.equal(out[0], 'one');
    assert.ok(out[1] instanceof Uint8Array);
    assert.deepEqual([...out[1]], [9, 8, 7]);
  });

  it('reassembles a frame split at every byte boundary', () => {
    const f = encodeFrame('split me');
    for (let cut = 1; cut < f.length; cut++) {
      const d = new FrameDecoder();
      const got = [...d.push(f.subarray(0, cut)), ...d.push(f.subarray(cut))];
      assert.deepEqual(got, ['split me'], `cut at ${cut}`);
    }
  });

  it('splits several frames delivered in one chunk', () => {
    const a = encodeFrame('a');
    const b = encodeFrame('b');
    const both = new Uint8Array(a.length + b.length);
    both.set(a, 0);
    both.set(b, a.length);
    assert.deepEqual(new FrameDecoder().push(both), ['a', 'b']);
  });

  it('refuses an oversize header before any payload has arrived', () => {
    const d = new FrameDecoder({ maxFrameBytes: 1024 });
    // A header announcing 4 GiB - 1 and nothing else: it must fail on the header alone.
    assert.throws(() => d.push(new Uint8Array([0xff, 0xff, 0xff, 0xff])), (e) => e.code === 'WSH_FRAME_TOO_LARGE');
    assert.equal(d.bufferedBytes, 0, 'nothing was buffered for it');
  });

  it('refuses an oversize header even when it arrives one byte at a time', () => {
    const d = new FrameDecoder({ maxFrameBytes: 16 });
    const header = new Uint8Array([0, 0, 1, 0]); // 256 > 16
    d.push(header.subarray(0, 1));
    d.push(header.subarray(1, 2));
    d.push(header.subarray(2, 3));
    assert.throws(() => d.push(header.subarray(3, 4)), (e) => e.code === 'WSH_FRAME_TOO_LARGE');
  });

  it('accepts a frame exactly at the limit and refuses one byte over', () => {
    const ok = encodeFrame(enc.encode('x'.repeat(15)), { maxFrameBytes: 16 }); // 15 payload + 1 kind = 16
    assert.equal(new FrameDecoder({ maxFrameBytes: 16 }).push(ok).length, 1);
    const over = encodeFrame(enc.encode('x'.repeat(16)), { maxFrameBytes: 64 }); // 17 > 16
    assert.throws(() => new FrameDecoder({ maxFrameBytes: 16 }).push(over), (e) => e.code === 'WSH_FRAME_TOO_LARGE');
  });

  it('refuses a zero length and an unknown kind as bad frames', () => {
    assert.throws(() => new FrameDecoder().push(new Uint8Array([0, 0, 0, 0])), (e) => e.code === 'WSH_BAD_FRAME');
    assert.throws(() => new FrameDecoder().push(new Uint8Array([0, 0, 0, 2, 7, 1])), (e) => e.code === 'WSH_BAD_FRAME');
  });

  it('refuses invalid UTF-8 in a text frame', () => {
    assert.throws(() => new FrameDecoder().push(new Uint8Array([0, 0, 0, 3, FRAME_KIND_TEXT, 0xff, 0xfe])), (e) => e.code === 'WSH_BAD_FRAME');
  });

  it('is unusable after an error (a link that framed badly is dead)', () => {
    const d = new FrameDecoder({ maxFrameBytes: 8 });
    assert.throws(() => d.push(new Uint8Array([0, 0, 1, 0])));
    assert.throws(() => d.push(encodeFrame('ok')), (e) => e.code === 'WSH_BAD_FRAME');
  });

  it('reports a stream that ended inside a frame', () => {
    const d = new FrameDecoder();
    d.push(encodeFrame('whole').subarray(0, 4));
    assert.throws(() => d.end(), (e) => e.code === 'WSH_BAD_FRAME');
    assert.doesNotThrow(() => new FrameDecoder().end());
  });
});
