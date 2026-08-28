import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BYTE_STREAM, isByteStream, asByteStream, createPipe, pipe, devNull, compose } from '../src/byte-stream.mjs';

describe('isByteStream', () => {
  it('returns true for compliant objects', () => {
    assert.ok(isByteStream({ read() {}, write() {}, close() {} }));
  });

  it('returns false for non-compliant objects', () => {
    assert.ok(!isByteStream(null));
    assert.ok(!isByteStream({}));
    assert.ok(!isByteStream({ read() {} }));
  });
});

describe('asByteStream', () => {
  it('tags object with BYTE_STREAM symbol', () => {
    const obj = { read() {}, write() {}, close() {} };
    const tagged = asByteStream(obj);
    assert.equal(tagged[BYTE_STREAM], true);
    assert.equal(tagged, obj); // same reference
  });

  it('is idempotent', () => {
    const obj = { read() {}, write() {}, close() {}, [BYTE_STREAM]: true };
    assert.equal(asByteStream(obj), obj);
  });
});

describe('createPipe', () => {
  it('write→read roundtrip', async () => {
    const [reader, writer] = createPipe();
    const data = new Uint8Array([1, 2, 3]);
    await writer.write(data);
    const received = await reader.read();
    assert.deepEqual(received, data);
    await reader.close();
    await writer.close();
  });

  it('multiple writes then reads', async () => {
    const [reader, writer] = createPipe();
    await writer.write(new Uint8Array([10]));
    await writer.write(new Uint8Array([20]));
    assert.deepEqual(await reader.read(), new Uint8Array([10]));
    assert.deepEqual(await reader.read(), new Uint8Array([20]));
    await reader.close();
    await writer.close();
  });

  it('close writer → reader gets null', async () => {
    const [reader, writer] = createPipe();
    await writer.close();
    assert.equal(await reader.read(), null);
    await reader.close();
  });

  it('write to closed pipe throws StreamClosedError', async () => {
    const [reader, writer] = createPipe();
    await writer.close();
    await assert.rejects(() => writer.write(new Uint8Array([1])), { name: 'StreamClosedError' });
    await reader.close();
  });

  it('reader and writer are tagged as ByteStreams', () => {
    const [reader, writer] = createPipe();
    assert.equal(reader[BYTE_STREAM], true);
    assert.equal(writer[BYTE_STREAM], true);
  });
});

describe('pipe', () => {
  it('transfers all data from src to dst', async () => {
    const [srcR, srcW] = createPipe();
    const [dstR, dstW] = createPipe();
    await srcW.write(new Uint8Array([1, 2]));
    await srcW.write(new Uint8Array([3, 4]));
    await srcW.close();
    await pipe(srcR, dstW);
    assert.deepEqual(await dstR.read(), new Uint8Array([1, 2]));
    assert.deepEqual(await dstR.read(), new Uint8Array([3, 4]));
    await dstR.close();
    await dstW.close();
  });
});

describe('devNull', () => {
  it('read returns null', async () => {
    const dn = devNull();
    assert.equal(await dn.read(), null);
  });

  it('write is silent', async () => {
    const dn = devNull();
    await dn.write(new Uint8Array([1, 2, 3])); // no throw
  });

  it('is a ByteStream', () => {
    assert.ok(isByteStream(devNull()));
    assert.equal(devNull()[BYTE_STREAM], true);
  });
});

describe('compose', () => {
  it('applies transform on read', async () => {
    const [reader, writer] = createPipe();
    // Transform: XOR each byte with 0xFF
    const xorTransform = {
      transform(chunk) {
        return chunk.map(b => b ^ 0xFF);
      },
    };
    const composed = compose(reader, xorTransform);
    await writer.write(new Uint8Array([0x00, 0xFF, 0x0F]));
    const result = await composed.read();
    assert.deepEqual(result, new Uint8Array([0xFF, 0x00, 0xF0]));
    await composed.close();
    await writer.close();
  });

  it('applies transform in reverse on write', async () => {
    const [reader, writer] = createPipe();
    const xorTransform = {
      transform(chunk) {
        return chunk.map(b => b ^ 0xFF);
      },
    };
    const composed = compose(writer, xorTransform);
    await composed.write(new Uint8Array([0x00, 0xFF]));
    const result = await reader.read();
    assert.deepEqual(result, new Uint8Array([0xFF, 0x00]));
    await composed.close();
    await reader.close();
  });

  it('chains multiple transforms', async () => {
    const [reader, writer] = createPipe();
    const addOne = { transform(chunk) { return chunk.map(b => b + 1); } };
    const double = { transform(chunk) { return chunk.map(b => b * 2); } };
    const composed = compose(reader, addOne, double);
    await writer.write(new Uint8Array([1, 2, 3]));
    const result = await composed.read();
    // (1+1)*2=4, (2+1)*2=6, (3+1)*2=8
    assert.deepEqual(result, new Uint8Array([4, 6, 8]));
    await composed.close();
    await writer.close();
  });

  it('zero transforms returns same stream', () => {
    const [reader] = createPipe();
    assert.equal(compose(reader), reader);
  });

  it('null from read passes through', async () => {
    const [reader, writer] = createPipe();
    const noop = { transform(chunk) { return chunk; } };
    const composed = compose(reader, noop);
    await writer.close();
    assert.equal(await composed.read(), null);
    await composed.close();
  });

  it('is tagged as ByteStream', () => {
    const [reader] = createPipe();
    const composed = compose(reader, { transform(c) { return c; } });
    assert.equal(composed[BYTE_STREAM], true);
  });
});
