// Run with: node --import ./test/_setup-globals.mjs --test test/audit.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  AuditEntry,
  AuditChain,
  AuditStore,
  GENESIS_HASH,
  detectFork,
  buildMerkleRoot,
  buildMerkleProof,
  verifyMerkleProof,
  AUDIT_ENTRY,
  AUDIT_CHAIN_QUERY,
  AUDIT_CHAIN_RESPONSE,
  encodeBase64url,
  decodeBase64url,
} from '../src/audit.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate an Ed25519 key pair for testing. */
async function generateKey() {
  return crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
}

/** Create a signFn from a private key. */
function makeSignFn(privateKey) {
  return async (bytes) =>
    new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, bytes));
}

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

describe('Wire constants', () => {
  it('AUDIT_ENTRY is 0xC4', () => {
    assert.equal(AUDIT_ENTRY, 0xC4);
  });

  it('AUDIT_CHAIN_QUERY is 0xC5', () => {
    assert.equal(AUDIT_CHAIN_QUERY, 0xC5);
  });

  it('AUDIT_CHAIN_RESPONSE is 0xC6', () => {
    assert.equal(AUDIT_CHAIN_RESPONSE, 0xC6);
  });

  it('constants are distinct', () => {
    const vals = [AUDIT_ENTRY, AUDIT_CHAIN_QUERY, AUDIT_CHAIN_RESPONSE];
    assert.equal(new Set(vals).size, 3);
  });
});

// ---------------------------------------------------------------------------
// GENESIS_HASH
// ---------------------------------------------------------------------------

describe('GENESIS_HASH', () => {
  it('is a 32-byte Uint8Array of all zeros', () => {
    assert.ok(GENESIS_HASH instanceof Uint8Array);
    assert.equal(GENESIS_HASH.length, 32);
    for (let i = 0; i < 32; i++) {
      assert.equal(GENESIS_HASH[i], 0);
    }
  });
});

// ---------------------------------------------------------------------------
// AuditEntry
// ---------------------------------------------------------------------------

describe('AuditEntry', () => {
  it('constructs with required fields', () => {
    const entry = new AuditEntry({
      sequence: 0,
      authorPodId: 'pod-abc',
      operation: 'create',
      data: { key: 'value' },
      previousHash: GENESIS_HASH,
      timestamp: 1000,
    });
    assert.equal(entry.sequence, 0);
    assert.equal(entry.authorPodId, 'pod-abc');
    assert.equal(entry.operation, 'create');
    assert.deepEqual(entry.data, { key: 'value' });
    assert.ok(entry.previousHash instanceof Uint8Array);
    assert.equal(entry.timestamp, 1000);
    assert.equal(entry.signature, null);
  });

  it('stores signature when provided', () => {
    const sig = new Uint8Array([1, 2, 3, 4]);
    const entry = new AuditEntry({
      sequence: 0,
      authorPodId: 'pod-a',
      operation: 'test',
      data: null,
      previousHash: GENESIS_HASH,
      timestamp: 1000,
      signature: sig,
    });
    assert.deepEqual(entry.signature, sig);
  });

  it('signedPayload returns deterministic canonical JSON', () => {
    const entry = new AuditEntry({
      sequence: 0,
      authorPodId: 'pod-a',
      operation: 'op',
      data: { z: 1, a: 2 },
      previousHash: GENESIS_HASH,
      timestamp: 5000,
    });
    const payload1 = entry.signedPayload;
    const payload2 = entry.signedPayload;
    assert.equal(payload1, payload2);
    // Keys should be sorted in canonical JSON
    assert.ok(payload1.indexOf('"a"') < payload1.indexOf('"z"'));
  });

  it('signedPayload excludes signature', () => {
    const entry = new AuditEntry({
      sequence: 0,
      authorPodId: 'pod-a',
      operation: 'op',
      data: null,
      previousHash: GENESIS_HASH,
      timestamp: 1000,
      signature: new Uint8Array([255]),
    });
    const payload = entry.signedPayload;
    assert.ok(!payload.includes('"signature"'));
  });

  it('hash returns a 32-byte SHA-256', async () => {
    const entry = new AuditEntry({
      sequence: 0,
      authorPodId: 'pod-a',
      operation: 'test',
      data: null,
      previousHash: GENESIS_HASH,
      timestamp: 1000,
    });
    const h = await entry.hash();
    assert.ok(h instanceof Uint8Array);
    assert.equal(h.length, 32);
  });

  it('hash is deterministic', async () => {
    const opts = {
      sequence: 0,
      authorPodId: 'pod-a',
      operation: 'test',
      data: 'hello',
      previousHash: GENESIS_HASH,
      timestamp: 1000,
    };
    const e1 = new AuditEntry(opts);
    const e2 = new AuditEntry(opts);
    const h1 = await e1.hash();
    const h2 = await e2.hash();
    assert.deepEqual(h1, h2);
  });

  it('toJSON serializes binary fields as base64url', () => {
    const entry = new AuditEntry({
      sequence: 0,
      authorPodId: 'pod-a',
      operation: 'op',
      data: 42,
      previousHash: GENESIS_HASH,
      timestamp: 1000,
      signature: new Uint8Array([10, 20, 30]),
    });
    const json = entry.toJSON();
    assert.equal(typeof json.previousHash, 'string');
    assert.equal(typeof json.signature, 'string');
    assert.equal(json.sequence, 0);
    assert.equal(json.data, 42);
  });

  it('toJSON / fromJSON round-trips correctly', async () => {
    const entry = new AuditEntry({
      sequence: 3,
      authorPodId: 'pod-x',
      operation: 'update',
      data: { nested: [1, 2] },
      previousHash: new Uint8Array(32).fill(0xAB),
      timestamp: 9876,
      signature: new Uint8Array([99, 100, 101]),
    });
    const json = entry.toJSON();
    const restored = AuditEntry.fromJSON(json);
    assert.equal(restored.sequence, 3);
    assert.equal(restored.authorPodId, 'pod-x');
    assert.equal(restored.operation, 'update');
    assert.deepEqual(restored.data, { nested: [1, 2] });
    assert.deepEqual(restored.previousHash, entry.previousHash);
    assert.deepEqual(restored.signature, entry.signature);
    assert.equal(restored.timestamp, 9876);
    // Hashes should match
    const h1 = await entry.hash();
    const h2 = await restored.hash();
    assert.deepEqual(h1, h2);
  });

  it('fromJSON handles null signature', () => {
    const json = {
      sequence: 0,
      authorPodId: 'pod',
      operation: 'op',
      data: null,
      previousHash: encodeBase64url(GENESIS_HASH),
      timestamp: 0,
      signature: null,
    };
    const entry = AuditEntry.fromJSON(json);
    assert.equal(entry.signature, null);
  });
});

// ---------------------------------------------------------------------------
// AuditChain
// ---------------------------------------------------------------------------

describe('AuditChain', () => {
  let keyPair;
  let signFn;

  beforeEach(async () => {
    keyPair = await generateKey();
    signFn = makeSignFn(keyPair.privateKey);
  });

  it('constructor requires a non-empty chainId', () => {
    assert.throws(() => new AuditChain(''), /non-empty string/);
    assert.throws(() => new AuditChain(null), /non-empty string/);
  });

  it('chainId getter returns the id', () => {
    const chain = new AuditChain('my-chain');
    assert.equal(chain.chainId, 'my-chain');
  });

  it('starts with length 0', () => {
    const chain = new AuditChain('test');
    assert.equal(chain.length, 0);
  });

  describe('append', () => {
    it('creates a signed entry at sequence 0 with genesis hash', async () => {
      const chain = new AuditChain('test');
      const entry = await chain.append('pod-a', 'create', { v: 1 }, signFn);
      assert.equal(entry.sequence, 0);
      assert.equal(entry.authorPodId, 'pod-a');
      assert.equal(entry.operation, 'create');
      assert.deepEqual(entry.data, { v: 1 });
      assert.deepEqual(entry.previousHash, GENESIS_HASH);
      assert.ok(entry.signature instanceof Uint8Array);
      assert.ok(entry.signature.length > 0);
      assert.equal(chain.length, 1);
    });

    it('links subsequent entries by hash', async () => {
      const chain = new AuditChain('test');
      const e0 = await chain.append('pod-a', 'op1', null, signFn);
      const e1 = await chain.append('pod-a', 'op2', null, signFn);
      assert.equal(e1.sequence, 1);
      const expectedPrev = await e0.hash();
      assert.deepEqual(e1.previousHash, expectedPrev);
    });

    it('increments sequence for each append', async () => {
      const chain = new AuditChain('test');
      for (let i = 0; i < 5; i++) {
        const e = await chain.append('pod-a', `op${i}`, null, signFn);
        assert.equal(e.sequence, i);
      }
      assert.equal(chain.length, 5);
    });

    it('supports different authors per entry', async () => {
      const chain = new AuditChain('multi');
      const kp2 = await generateKey();
      const signFn2 = makeSignFn(kp2.privateKey);

      await chain.append('pod-a', 'op1', null, signFn);
      await chain.append('pod-b', 'op2', null, signFn2);
      assert.equal(chain.get(0).authorPodId, 'pod-a');
      assert.equal(chain.get(1).authorPodId, 'pod-b');
    });
  });

  describe('verify', () => {
    it('verifies a valid chain', async () => {
      const chain = new AuditChain('test');
      await chain.append('pod-a', 'op1', 'data1', signFn);
      await chain.append('pod-a', 'op2', 'data2', signFn);
      await chain.append('pod-a', 'op3', 'data3', signFn);

      const result = await chain.verify(async () => keyPair.publicKey);
      assert.equal(result.valid, true);
      assert.equal(result.error, undefined);
    });

    it('detects invalid signature', async () => {
      const chain = new AuditChain('test');
      await chain.append('pod-a', 'op1', null, signFn);

      // Use a different key for verification
      const other = await generateKey();
      const result = await chain.verify(async () => other.publicKey);
      assert.equal(result.valid, false);
      assert.equal(result.error, 'invalid signature');
      assert.equal(result.failedAt, 0);
    });

    it('detects tampered previousHash', async () => {
      const chain = new AuditChain('test');
      await chain.append('pod-a', 'op1', null, signFn);
      await chain.append('pod-a', 'op2', null, signFn);

      // Tamper with entry 1's previousHash
      const e1 = chain.get(1);
      e1.previousHash = new Uint8Array(32).fill(0xFF);

      const result = await chain.verify(async () => keyPair.publicKey);
      assert.equal(result.valid, false);
      assert.equal(result.failedAt, 1);
    });

    it('detects missing signature', async () => {
      const chain = new AuditChain('test');
      await chain.append('pod-a', 'op1', null, signFn);
      // Remove signature
      chain.get(0).signature = null;

      const result = await chain.verify(async () => keyPair.publicKey);
      assert.equal(result.valid, false);
      assert.equal(result.error, 'missing signature');
      assert.equal(result.failedAt, 0);
    });

    it('returns valid for empty chain', async () => {
      const chain = new AuditChain('test');
      const result = await chain.verify(async () => null);
      assert.equal(result.valid, true);
    });

    it('accepts raw public key bytes', async () => {
      const chain = new AuditChain('test');
      await chain.append('pod-a', 'op1', 'hello', signFn);

      const rawKey = new Uint8Array(
        await crypto.subtle.exportKey('raw', keyPair.publicKey)
      );

      const result = await chain.verify(async () => rawKey);
      assert.equal(result.valid, true);
    });

    it('detects sequence mismatch', async () => {
      const chain = new AuditChain('test');
      await chain.append('pod-a', 'op1', null, signFn);
      // Tamper with sequence
      chain.get(0).sequence = 5;

      const result = await chain.verify(async () => keyPair.publicKey);
      assert.equal(result.valid, false);
      assert.equal(result.error, 'sequence mismatch');
      assert.equal(result.failedAt, 0);
    });
  });

  describe('get', () => {
    it('returns entry at given sequence', async () => {
      const chain = new AuditChain('test');
      await chain.append('pod-a', 'op1', 'first', signFn);
      await chain.append('pod-a', 'op2', 'second', signFn);

      assert.equal(chain.get(0).data, 'first');
      assert.equal(chain.get(1).data, 'second');
    });

    it('returns null for out-of-range sequence', () => {
      const chain = new AuditChain('test');
      assert.equal(chain.get(0), null);
      assert.equal(chain.get(99), null);
    });
  });

  describe('entries iterator', () => {
    it('iterates over all entries in order', async () => {
      const chain = new AuditChain('test');
      await chain.append('pod-a', 'op1', null, signFn);
      await chain.append('pod-a', 'op2', null, signFn);
      await chain.append('pod-a', 'op3', null, signFn);

      const ops = [];
      for (const entry of chain.entries()) {
        ops.push(entry.operation);
      }
      assert.deepEqual(ops, ['op1', 'op2', 'op3']);
    });

    it('returns nothing for empty chain', () => {
      const chain = new AuditChain('empty');
      const items = [...chain.entries()];
      assert.equal(items.length, 0);
    });
  });

  describe('slice', () => {
    it('returns a sub-array of entries', async () => {
      const chain = new AuditChain('test');
      for (let i = 0; i < 5; i++) {
        await chain.append('pod-a', `op${i}`, null, signFn);
      }
      const sliced = chain.slice(1, 3);
      assert.equal(sliced.length, 2);
      assert.equal(sliced[0].sequence, 1);
      assert.equal(sliced[1].sequence, 2);
    });

    it('defaults to full range', async () => {
      const chain = new AuditChain('test');
      await chain.append('pod-a', 'op', null, signFn);
      const sliced = chain.slice();
      assert.equal(sliced.length, 1);
    });
  });

  describe('toJSON / fromJSON', () => {
    it('round-trips a chain with entries', async () => {
      const chain = new AuditChain('persist-test');
      await chain.append('pod-a', 'create', { x: 1 }, signFn);
      await chain.append('pod-a', 'update', { x: 2 }, signFn);

      const json = chain.toJSON();
      assert.equal(json.chainId, 'persist-test');
      assert.equal(json.entries.length, 2);

      const restored = AuditChain.fromJSON(json);
      assert.equal(restored.chainId, 'persist-test');
      assert.equal(restored.length, 2);
      assert.equal(restored.get(0).operation, 'create');
      assert.equal(restored.get(1).operation, 'update');
      assert.deepEqual(restored.get(0).data, { x: 1 });
    });

    it('preserved entries verify after round-trip', async () => {
      const chain = new AuditChain('verify-rt');
      await chain.append('pod-a', 'op', 'data', signFn);

      const json = chain.toJSON();
      const restored = AuditChain.fromJSON(json);

      const result = await restored.verify(async () => keyPair.publicKey);
      assert.equal(result.valid, true);
    });

    it('round-trips empty chain', () => {
      const chain = new AuditChain('empty');
      const json = chain.toJSON();
      const restored = AuditChain.fromJSON(json);
      assert.equal(restored.chainId, 'empty');
      assert.equal(restored.length, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// AuditStore
// ---------------------------------------------------------------------------

describe('AuditStore', () => {
  let store;

  beforeEach(() => {
    store = new AuditStore();
  });

  it('starts with size 0', () => {
    assert.equal(store.size, 0);
  });

  it('createChain returns a new AuditChain', () => {
    const chain = store.createChain('alpha');
    assert.ok(chain instanceof AuditChain);
    assert.equal(chain.chainId, 'alpha');
    assert.equal(store.size, 1);
  });

  it('createChain throws for duplicate chainId', () => {
    store.createChain('alpha');
    assert.throws(() => store.createChain('alpha'), /already exists/);
  });

  it('getChain returns the chain', () => {
    store.createChain('beta');
    const chain = store.getChain('beta');
    assert.ok(chain instanceof AuditChain);
    assert.equal(chain.chainId, 'beta');
  });

  it('getChain returns null for unknown', () => {
    assert.equal(store.getChain('nope'), null);
  });

  it('hasChain returns true/false', () => {
    store.createChain('gamma');
    assert.equal(store.hasChain('gamma'), true);
    assert.equal(store.hasChain('delta'), false);
  });

  it('deleteChain removes and returns true', () => {
    store.createChain('remove-me');
    assert.equal(store.deleteChain('remove-me'), true);
    assert.equal(store.size, 0);
    assert.equal(store.hasChain('remove-me'), false);
  });

  it('deleteChain returns false for unknown', () => {
    assert.equal(store.deleteChain('nonexistent'), false);
  });

  it('listChains returns all chain IDs', () => {
    store.createChain('a');
    store.createChain('b');
    store.createChain('c');
    const ids = store.listChains();
    assert.deepEqual(ids.sort(), ['a', 'b', 'c']);
  });

  it('listChains returns empty array when empty', () => {
    assert.deepEqual(store.listChains(), []);
  });

  it('size tracks additions and deletions', () => {
    store.createChain('x');
    store.createChain('y');
    assert.equal(store.size, 2);
    store.deleteChain('x');
    assert.equal(store.size, 1);
  });
});

// ---------------------------------------------------------------------------
// detectFork
// ---------------------------------------------------------------------------

describe('detectFork', () => {
  it('returns null for empty entries', async () => {
    assert.equal(await detectFork([]), null);
  });

  it('returns null when no fork exists', async () => {
    const chain = new AuditChain('test');
    const kp = await generateKey();
    const sf = makeSignFn(kp.privateKey);
    await chain.append('pod-a', 'op1', null, sf);
    await chain.append('pod-a', 'op2', null, sf);
    const entries = [...chain.entries()];
    assert.equal(await detectFork(entries), null);
  });

  it('detects fork at divergent sequence', async () => {
    // Build two entries at sequence 1 with different content
    const e0 = new AuditEntry({
      sequence: 0,
      authorPodId: 'pod-a',
      operation: 'op',
      data: 'same',
      previousHash: GENESIS_HASH,
      timestamp: 1000,
    });

    const hash0 = await e0.hash();

    const e1a = new AuditEntry({
      sequence: 1,
      authorPodId: 'pod-a',
      operation: 'branch-a',
      data: 'fork-a',
      previousHash: hash0,
      timestamp: 2000,
    });

    const e1b = new AuditEntry({
      sequence: 1,
      authorPodId: 'pod-b',
      operation: 'branch-b',
      data: 'fork-b',
      previousHash: hash0,
      timestamp: 2001,
    });

    const result = await detectFork([e0, e1a, e1b]);
    assert.ok(result !== null);
    assert.equal(result.ancestor, 0);
    assert.equal(result.branches.length, 2);
  });

  it('returns null for duplicate identical entries at same sequence', async () => {
    const entry = new AuditEntry({
      sequence: 0,
      authorPodId: 'pod-a',
      operation: 'op',
      data: 'same',
      previousHash: GENESIS_HASH,
      timestamp: 1000,
    });
    // Same entry duplicated is not a fork
    const result = await detectFork([entry, entry]);
    assert.equal(result, null);
  });

  it('detects fork at sequence 0', async () => {
    const e0a = new AuditEntry({
      sequence: 0,
      authorPodId: 'pod-a',
      operation: 'op-a',
      data: 'alpha',
      previousHash: GENESIS_HASH,
      timestamp: 1000,
    });
    const e0b = new AuditEntry({
      sequence: 0,
      authorPodId: 'pod-b',
      operation: 'op-b',
      data: 'beta',
      previousHash: GENESIS_HASH,
      timestamp: 1001,
    });

    const result = await detectFork([e0a, e0b]);
    assert.ok(result !== null);
    assert.equal(result.ancestor, -1);
    assert.equal(result.branches.length, 2);
  });
});

// ---------------------------------------------------------------------------
// MerkleProof
// ---------------------------------------------------------------------------

describe('MerkleProof', () => {
  let chain;
  let keyPair;
  let signFn;

  beforeEach(async () => {
    keyPair = await generateKey();
    signFn = makeSignFn(keyPair.privateKey);
    chain = new AuditChain('merkle-test');
    await chain.append('pod-a', 'op0', 'data0', signFn);
    await chain.append('pod-a', 'op1', 'data1', signFn);
    await chain.append('pod-a', 'op2', 'data2', signFn);
    await chain.append('pod-a', 'op3', 'data3', signFn);
  });

  describe('buildMerkleRoot', () => {
    it('returns a 32-byte hash', async () => {
      const entries = [...chain.entries()];
      const root = await buildMerkleRoot(entries);
      assert.ok(root instanceof Uint8Array);
      assert.equal(root.length, 32);
    });

    it('returns zeros for empty entries', async () => {
      const root = await buildMerkleRoot([]);
      assert.equal(root.length, 32);
      for (let i = 0; i < 32; i++) {
        assert.equal(root[i], 0);
      }
    });

    it('is deterministic', async () => {
      const entries = [...chain.entries()];
      const r1 = await buildMerkleRoot(entries);
      const r2 = await buildMerkleRoot(entries);
      assert.deepEqual(r1, r2);
    });

    it('changes when an entry is modified', async () => {
      const entries = [...chain.entries()];
      const r1 = await buildMerkleRoot(entries);

      // Create a modified copy
      const modified = entries.map((e) => new AuditEntry({
        sequence: e.sequence,
        authorPodId: e.authorPodId,
        operation: e.operation,
        data: e.data,
        previousHash: e.previousHash,
        timestamp: e.timestamp,
        signature: e.signature,
      }));
      modified[2].data = 'TAMPERED';

      const r2 = await buildMerkleRoot(modified);
      assert.notDeepEqual(r1, r2);
    });

    it('works with a single entry', async () => {
      const singleChain = new AuditChain('single');
      await singleChain.append('pod-a', 'only', null, signFn);
      const entries = [...singleChain.entries()];
      const root = await buildMerkleRoot(entries);
      // Should be the hash of the single entry
      const entryHash = await entries[0].hash();
      assert.deepEqual(root, entryHash);
    });
  });

  describe('buildMerkleProof', () => {
    it('builds a proof for index 0', async () => {
      const entries = [...chain.entries()];
      const { root, proof, index } = await buildMerkleProof(entries, 0);
      assert.equal(index, 0);
      assert.ok(root instanceof Uint8Array);
      assert.ok(Array.isArray(proof));
      assert.ok(proof.length > 0);
      for (const step of proof) {
        assert.ok(step.hash instanceof Uint8Array);
        assert.ok(['left', 'right'].includes(step.position));
      }
    });

    it('throws for out-of-range index', async () => {
      const entries = [...chain.entries()];
      await assert.rejects(
        () => buildMerkleProof(entries, 10),
        RangeError
      );
      await assert.rejects(
        () => buildMerkleProof(entries, -1),
        RangeError
      );
    });

    it('proof root matches buildMerkleRoot', async () => {
      const entries = [...chain.entries()];
      const expectedRoot = await buildMerkleRoot(entries);
      const { root } = await buildMerkleProof(entries, 2);
      assert.deepEqual(root, expectedRoot);
    });
  });

  describe('verifyMerkleProof', () => {
    it('verifies a valid proof for each index', async () => {
      const entries = [...chain.entries()];
      for (let i = 0; i < entries.length; i++) {
        const { root, proof, index } = await buildMerkleProof(entries, i);
        const entryHash = await entries[i].hash();
        const valid = await verifyMerkleProof(entryHash, proof, index, root);
        assert.equal(valid, true, `proof failed for index ${i}`);
      }
    });

    it('rejects a tampered entry hash', async () => {
      const entries = [...chain.entries()];
      const { root, proof, index } = await buildMerkleProof(entries, 1);
      const fakeHash = new Uint8Array(32).fill(0xDE);
      const valid = await verifyMerkleProof(fakeHash, proof, index, root);
      assert.equal(valid, false);
    });

    it('rejects a tampered proof step', async () => {
      const entries = [...chain.entries()];
      const { root, proof, index } = await buildMerkleProof(entries, 0);
      const entryHash = await entries[0].hash();

      // Tamper with first proof step
      const tamperedProof = proof.map((s) => ({ ...s, hash: new Uint8Array(s.hash) }));
      tamperedProof[0].hash[0] ^= 0xFF;

      const valid = await verifyMerkleProof(entryHash, tamperedProof, index, root);
      assert.equal(valid, false);
    });

    it('rejects proof against wrong root', async () => {
      const entries = [...chain.entries()];
      const { proof, index } = await buildMerkleProof(entries, 0);
      const entryHash = await entries[0].hash();
      const wrongRoot = new Uint8Array(32).fill(0xBA);
      const valid = await verifyMerkleProof(entryHash, proof, index, wrongRoot);
      assert.equal(valid, false);
    });

    it('works with a single entry', async () => {
      const singleChain = new AuditChain('single');
      await singleChain.append('pod-a', 'only', null, signFn);
      const entries = [...singleChain.entries()];
      const { root, proof, index } = await buildMerkleProof(entries, 0);
      const entryHash = await entries[0].hash();
      const valid = await verifyMerkleProof(entryHash, proof, index, root);
      assert.equal(valid, true);
    });
  });
});

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

describe('Re-exports', () => {
  it('encodeBase64url is a function', () => {
    assert.equal(typeof encodeBase64url, 'function');
  });

  it('decodeBase64url is a function', () => {
    assert.equal(typeof decodeBase64url, 'function');
  });

  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 128, 255]);
    assert.deepEqual(decodeBase64url(encodeBase64url(bytes)), bytes);
  });
});
