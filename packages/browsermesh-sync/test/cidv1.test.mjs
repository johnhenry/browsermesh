// Run with: node --import ./test/_setup-globals.mjs --test test/cidv1.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChunkStore } from '../src/files.mjs';
import {
  computeCidV1,
  buildUnixfsFile,
  buildUnixfsDirectory,
  verifyBlock,
  parseCid,
  cidV1FromSha256Hex,
  sha256HexFromCid,
  CIDV1_DEFAULTS,
} from '../src/cidv1.mjs';
import { FIXTURES, pseudoBytes } from './fixtures/cidv1-trees.mjs';

const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/cidv1-golden.json', import.meta.url), 'utf8'));
const enc = new TextEncoder();

describe('CIDV1_DEFAULTS', () => {
  it('documents the importer parameters matched', () => {
    assert.deepEqual({ ...CIDV1_DEFAULTS }, { chunkSize: 262144, maxLinks: 174 });
    assert.ok(Object.isFrozen(CIDV1_DEFAULTS));
  });
});

describe('golden roots match ipfs-unixfs-importer', () => {
  for (const [name, fx] of Object.entries(FIXTURES)) {
    it(`${name}: root CID and block count`, async () => {
      const res = fx.kind === 'file'
        ? await buildUnixfsFile(fx.bytes)
        : await buildUnixfsDirectory(fx.files);
      assert.equal(res.cid, GOLDEN[name].root);
      assert.equal(res.blocks.size, GOLDEN[name].blocks);
    });

    it(`${name}: every block verifies against its CID`, async () => {
      const res = fx.kind === 'file'
        ? await buildUnixfsFile(fx.bytes)
        : await buildUnixfsDirectory(fx.files);
      for (const [cid, bytes] of res.blocks) {
        assert.equal(await verifyBlock(cid, bytes), true, cid);
      }
    });
  }
});

describe('computeCidV1 / ChunkStore.computeCid', () => {
  it('raw-leaf CIDv1 of empty bytes is the well-known value', async () => {
    assert.equal(await computeCidV1(new Uint8Array(0)), 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku');
  });

  it('default format is unchanged SHA-256 hex', async () => {
    const data = enc.encode('hello world\n');
    const hex = await ChunkStore.computeCid(data);
    assert.match(hex, /^[0-9a-f]{64}$/);
    assert.equal(await ChunkStore.computeCid(data, {}), hex);
    assert.equal(await ChunkStore.computeCid(data, { format: 'sha256-hex' }), hex);
  });

  it("format 'cidv1' returns the raw-leaf CIDv1", async () => {
    const data = enc.encode('hello world\n');
    assert.equal(await ChunkStore.computeCid(data, { format: 'cidv1' }), GOLDEN['small-file'].root);
  });

  it('rejects unknown formats', async () => {
    await assert.rejects(() => ChunkStore.computeCid(new Uint8Array(1), { format: 'nope' }), /format/);
  });
});

describe('hex <-> raw-leaf CIDv1 conversion', () => {
  it('round-trips', async () => {
    const data = pseudoBytes(1000, 2);
    const hex = await ChunkStore.computeCid(data);
    const cid = cidV1FromSha256Hex(hex);
    assert.equal(cid, await computeCidV1(data));
    assert.equal(sha256HexFromCid(cid), hex);
  });

  it('sha256HexFromCid returns null for dag-pb CIDs', () => {
    assert.equal(sha256HexFromCid(GOLDEN['small-dir'].root), null);
  });

  it('cidV1FromSha256Hex rejects malformed input', () => {
    assert.throws(() => cidV1FromSha256Hex('abc'), /sha-?256/i);
  });
});

describe('parseCid', () => {
  it('parses codec and digest', () => {
    const p = parseCid(GOLDEN['small-dir'].root);
    assert.equal(p.version, 1);
    assert.equal(p.codec, 'dag-pb');
    assert.equal(p.digest.length, 32);
    assert.equal(parseCid(GOLDEN['small-file'].root).codec, 'raw');
  });

  it('rejects non-CIDv1 / non-base32 / unsupported hash', () => {
    assert.throws(() => parseCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'));
    assert.throws(() => parseCid('not a cid'));
    assert.throws(() => parseCid(''));
  });
});

describe('verifyBlock', () => {
  it('works for both address forms', async () => {
    const data = enc.encode('abc');
    const hex = await ChunkStore.computeCid(data);
    const cid = await computeCidV1(data);
    assert.equal(await verifyBlock(hex, data), true);
    assert.equal(await verifyBlock(cid, data), true);
  });

  it('detects tampering in both forms', async () => {
    const data = enc.encode('abc');
    const bad = enc.encode('abd');
    assert.equal(await verifyBlock(await ChunkStore.computeCid(data), bad), false);
    assert.equal(await verifyBlock(await computeCidV1(data), bad), false);
  });

  it('returns false for garbage addresses instead of throwing', async () => {
    assert.equal(await verifyBlock('zzz', enc.encode('x')), false);
  });
});

describe('buildUnixfsDirectory', () => {
  it('accepts Map and plain-object input identically', async () => {
    const f = FIXTURES['nested-dirs'].files;
    const a = await buildUnixfsDirectory(f);
    const b = await buildUnixfsDirectory(new Map(Object.entries(f)));
    assert.equal(a.cid, b.cid);
  });

  it('is insensitive to insertion order', async () => {
    const f = FIXTURES['nested-dirs'].files;
    const rev = new Map(Object.entries(f).reverse());
    assert.equal((await buildUnixfsDirectory(rev)).cid, GOLDEN['nested-dirs'].root);
  });

  it('normalises leading/duplicate slashes', async () => {
    const r = await buildUnixfsDirectory({ '/a//b.txt': enc.encode('x') });
    const r2 = await buildUnixfsDirectory({ 'a/b.txt': enc.encode('x') });
    assert.equal(r.cid, r2.cid);
  });

  it('exposes per-path file CIDs', async () => {
    const r = await buildUnixfsDirectory(FIXTURES['small-dir'].files);
    assert.equal(r.files.get('index.html'), await computeCidV1(FIXTURES['small-dir'].files['index.html']));
    assert.deepEqual([...r.files.keys()].sort(), ['index.html', 'style.css']);
  });

  it('rejects empty trees, bad paths, and file/dir conflicts', async () => {
    await assert.rejects(() => buildUnixfsDirectory({}), /empty/i);
    await assert.rejects(() => buildUnixfsDirectory({ 'a/../b': enc.encode('x') }), /path/i);
    await assert.rejects(() => buildUnixfsDirectory({ a: enc.encode('x'), 'a/b': enc.encode('y') }), /conflict/i);
  });
});
