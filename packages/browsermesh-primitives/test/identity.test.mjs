import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeBase64url,
  decodeBase64url,
  derivePodId,
  PodIdentity,
} from '../src/identity.mjs';

describe('encodeBase64url', () => {
  it('encodes empty bytes', () => {
    assert.equal(encodeBase64url(new Uint8Array([])), '');
  });

  it('encodes single byte', () => {
    const result = encodeBase64url(new Uint8Array([0]));
    assert.equal(result, 'AA');
  });

  it('encodes known values', () => {
    // "Hello" in bytes
    const bytes = new TextEncoder().encode('Hello');
    const result = encodeBase64url(bytes);
    assert.equal(result, 'SGVsbG8');
  });

  it('replaces + with - and / with _', () => {
    // Bytes that produce + and / in standard base64
    // 0xfb, 0xef, 0xbe = standard base64 "++--" territory
    const bytes = new Uint8Array([0xfb, 0xef, 0xbe]);
    const result = encodeBase64url(bytes);
    assert.ok(!result.includes('+'), 'should not contain +');
    assert.ok(!result.includes('/'), 'should not contain /');
    assert.ok(!result.includes('='), 'should not contain padding');
  });

  it('strips padding', () => {
    // Single byte "A" => base64 "QQ==" => base64url "QQ"
    const bytes = new Uint8Array([0x41]);
    const result = encodeBase64url(bytes);
    assert.ok(!result.endsWith('='), 'should not end with =');
    assert.equal(result, 'QQ');
  });
});

describe('decodeBase64url', () => {
  it('decodes empty string', () => {
    const result = decodeBase64url('');
    assert.equal(result.length, 0);
  });

  it('decodes known values', () => {
    const result = decodeBase64url('SGVsbG8');
    const str = new TextDecoder().decode(result);
    assert.equal(str, 'Hello');
  });

  it('handles base64url characters (- and _)', () => {
    // Encode then decode with special characters
    const original = new Uint8Array([0xfb, 0xef, 0xbe]);
    const encoded = encodeBase64url(original);
    const decoded = decodeBase64url(encoded);
    assert.deepEqual(decoded, original);
  });

  it('handles strings without padding', () => {
    const result = decodeBase64url('QQ');
    assert.equal(result.length, 1);
    assert.equal(result[0], 0x41);
  });
});

describe('encodeBase64url / decodeBase64url round-trip', () => {
  it('round-trips arbitrary bytes', () => {
    const original = new Uint8Array([0, 1, 2, 128, 255, 127, 63, 191]);
    const encoded = encodeBase64url(original);
    const decoded = decodeBase64url(encoded);
    assert.deepEqual(decoded, original);
  });

  it('round-trips 32 random-ish bytes', () => {
    const original = new Uint8Array(32);
    for (let i = 0; i < 32; i++) original[i] = (i * 7 + 13) % 256;
    const encoded = encodeBase64url(original);
    const decoded = decodeBase64url(encoded);
    assert.deepEqual(decoded, original);
  });

  it('round-trips large payload', () => {
    const original = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) original[i] = i % 256;
    const encoded = encodeBase64url(original);
    const decoded = decodeBase64url(encoded);
    assert.deepEqual(decoded, original);
  });
});

describe('derivePodId', () => {
  it('derives a base64url string from an Ed25519 public key', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify']
    );
    const podId = await derivePodId(keyPair.publicKey);
    assert.equal(typeof podId, 'string');
    // SHA-256 hash is 32 bytes => base64url is 43 chars (no padding)
    assert.equal(podId.length, 43);
    // Should only contain base64url characters
    assert.ok(/^[A-Za-z0-9_-]+$/.test(podId));
  });

  it('produces deterministic output for same key', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify']
    );
    const id1 = await derivePodId(keyPair.publicKey);
    const id2 = await derivePodId(keyPair.publicKey);
    assert.equal(id1, id2);
  });

  it('produces different IDs for different keys', async () => {
    const kp1 = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify']
    );
    const kp2 = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify']
    );
    const id1 = await derivePodId(kp1.publicKey);
    const id2 = await derivePodId(kp2.publicKey);
    assert.notEqual(id1, id2);
  });
});

describe('PodIdentity', () => {
  describe('constructor', () => {
    it('stores keyPair and podId', () => {
      const identity = new PodIdentity({
        keyPair: { publicKey: 'pub', privateKey: 'priv' },
        podId: 'test-id',
      });
      assert.equal(identity.podId, 'test-id');
      assert.deepEqual(identity.keyPair, { publicKey: 'pub', privateKey: 'priv' });
    });
  });

  describe('generate', () => {
    it('creates a valid PodIdentity with Ed25519 keys', async () => {
      const identity = await PodIdentity.generate();
      assert.ok(identity instanceof PodIdentity);
      assert.equal(typeof identity.podId, 'string');
      assert.equal(identity.podId.length, 43);
      assert.ok(identity.keyPair.publicKey);
      assert.ok(identity.keyPair.privateKey);
    });

    it('generates unique identities', async () => {
      const id1 = await PodIdentity.generate();
      const id2 = await PodIdentity.generate();
      assert.notEqual(id1.podId, id2.podId);
    });
  });

  describe('sign and verify', () => {
    it('signs data and verifies the signature', async () => {
      const identity = await PodIdentity.generate();
      const data = new TextEncoder().encode('test message');
      const signature = await identity.sign(data);

      assert.ok(signature instanceof Uint8Array);
      assert.ok(signature.length > 0);

      const valid = await PodIdentity.verify(
        identity.keyPair.publicKey,
        data,
        signature
      );
      assert.equal(valid, true);
    });

    it('rejects tampered data', async () => {
      const identity = await PodIdentity.generate();
      const data = new TextEncoder().encode('original');
      const signature = await identity.sign(data);

      const tampered = new TextEncoder().encode('tampered');
      const valid = await PodIdentity.verify(
        identity.keyPair.publicKey,
        tampered,
        signature
      );
      assert.equal(valid, false);
    });

    it('rejects wrong public key', async () => {
      const id1 = await PodIdentity.generate();
      const id2 = await PodIdentity.generate();
      const data = new TextEncoder().encode('test');
      const signature = await id1.sign(data);

      const valid = await PodIdentity.verify(
        id2.keyPair.publicKey,
        data,
        signature
      );
      assert.equal(valid, false);
    });
  });
});
