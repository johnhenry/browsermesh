// Run with: node --import ./test/_setup-globals.mjs --test test/wsh-bridge.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MeshWshBridge,
  hexToBytes,
  bytesToHex,
} from '../src/wsh-bridge.mjs';
// Sibling package, not yet published — MeshIdentityManager lives in
// browsermesh-core (verified low-drift against the live web/clawser-mesh-
// identity.js this was ported from). Once both packages are published,
// switch this to a real "browsermesh-core" dependency.
import {
  MeshIdentityManager,
  InMemoryIdentityStorage,
  encodeBase64url,
  decodeBase64url,
} from '../../browsermesh-core/src/identity.mjs';

// ---------------------------------------------------------------------------
// Hex/Base64url conversion helpers
// ---------------------------------------------------------------------------

describe('hexToBytes / bytesToHex', () => {
  it('converts hex to bytes', () => {
    const bytes = hexToBytes('deadbeef');
    assert.equal(bytes.length, 4);
    assert.equal(bytes[0], 0xde);
    assert.equal(bytes[1], 0xad);
    assert.equal(bytes[2], 0xbe);
    assert.equal(bytes[3], 0xef);
  });

  it('converts bytes to hex', () => {
    const hex = bytesToHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    assert.equal(hex, 'deadbeef');
  });

  it('round-trips hex -> bytes -> hex', () => {
    const original = 'a1b2c3d4e5f6';
    assert.equal(bytesToHex(hexToBytes(original)), original);
  });

  it('handles 32-byte SHA-256 hash', () => {
    const hex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const bytes = hexToBytes(hex);
    assert.equal(bytes.length, 32);
    assert.equal(bytesToHex(bytes), hex);
  });

  it('empty input', () => {
    assert.equal(hexToBytes('').length, 0);
    assert.equal(bytesToHex(new Uint8Array([])), '');
  });
});

// ---------------------------------------------------------------------------
// Mock WshKeyStore (simulates key storage with in-memory maps)
// ---------------------------------------------------------------------------

class MockWshKeyStore {
  #keys = new Map();
  _db = true; // pretend DB is open

  async _ensureDb() {}

  async _put(entry) {
    this.#keys.set(entry.name, { ...entry });
  }

  async generateKey(name = 'default', { extractable = true } = {}) {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      extractable,
      ['sign', 'verify']
    );
    const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    const hash = await crypto.subtle.digest('SHA-256', raw);
    const fp = bytesToHex(new Uint8Array(hash));

    const entry = {
      name,
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
      createdAt: Date.now(),
      fingerprint: fp,
    };
    this.#keys.set(name, entry);
    return { name, fingerprint: fp };
  }

  async getKey(name) {
    return this.#keys.get(name) || null;
  }

  async listKeys() {
    return [...this.#keys.values()].map(({ name, fingerprint, createdAt }) => ({
      name,
      fingerprint,
      createdAt,
    }));
  }

  async getKeyPair(name) {
    const entry = this.#keys.get(name);
    if (!entry) throw new Error(`Key "${name}" not found`);
    return { publicKey: entry.publicKey, privateKey: entry.privateKey };
  }

  async deleteKey(name) {
    return this.#keys.delete(name);
  }
}

// ---------------------------------------------------------------------------
// MeshWshBridge
// ---------------------------------------------------------------------------

describe('MeshWshBridge', () => {
  let wshStore;
  let meshMgr;
  let bridge;

  beforeEach(() => {
    wshStore = new MockWshKeyStore();
    meshMgr = new MeshIdentityManager();
    bridge = new MeshWshBridge(wshStore, meshMgr);
  });

  // -- constructor --------------------------------------------------------

  it('throws if wshKeyStore is missing', () => {
    assert.throws(
      () => new MeshWshBridge(null, meshMgr),
      /wshKeyStore is required/
    );
  });

  it('throws if meshIdentityManager is missing', () => {
    assert.throws(
      () => new MeshWshBridge(wshStore, null),
      /meshIdentityManager is required/
    );
  });

  // -- format conversion --------------------------------------------------

  describe('fingerprint2podId / podId2fingerprint', () => {
    it('converts hex fingerprint to base64url pod ID', () => {
      // Both are SHA-256 hashes of the same public key
      // 32 bytes as hex = 64 chars, as base64url = 43 chars
      const hex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const podId = bridge.fingerprint2podId(hex);
      assert.equal(typeof podId, 'string');
      assert.ok(podId.length > 0);
      // Should not contain + / = (base64url encoding)
      assert.ok(!podId.includes('+'));
      assert.ok(!podId.includes('/'));
    });

    it('converts base64url pod ID back to hex fingerprint', () => {
      const hex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const podId = bridge.fingerprint2podId(hex);
      const backToHex = bridge.podId2fingerprint(podId);
      assert.equal(backToHex, hex);
    });

    it('round-trips correctly', () => {
      const hex = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
      const podId = bridge.fingerprint2podId(hex);
      const back = bridge.podId2fingerprint(podId);
      assert.equal(back, hex);
    });

    it('matches derivePodId format', async () => {
      // Generate a key and compute both formats
      const { name, fingerprint: fp } = await wshStore.generateKey('test');
      const keyPair = await wshStore.getKeyPair('test');

      // Compute pod ID the mesh way
      const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
      const hash = await crypto.subtle.digest('SHA-256', raw);
      const expectedPodId = encodeBase64url(new Uint8Array(hash));

      const bridgePodId = bridge.fingerprint2podId(fp);
      assert.equal(bridgePodId, expectedPodId);
    });
  });

  // -- importFromWsh ------------------------------------------------------

  describe('importFromWsh', () => {
    it('imports a key from WshKeyStore into MeshIdentityManager', async () => {
      const { name, fingerprint } = await wshStore.generateKey('wsh-key', { extractable: true });
      assert.equal(meshMgr.size, 0);

      const podId = await bridge.importFromWsh(fingerprint);
      assert.equal(meshMgr.size, 1);
      assert.ok(meshMgr.has(podId));

      const summary = meshMgr.get(podId);
      assert.equal(summary.label, 'wsh:wsh-key');
      assert.equal(summary.metadata.source, 'wsh');
      assert.equal(summary.metadata.wshFingerprint, fingerprint);
    });

    it('deduplicates: returns existing podId if already imported', async () => {
      const { fingerprint } = await wshStore.generateKey('dedup', { extractable: true });

      const podId1 = await bridge.importFromWsh(fingerprint);
      const podId2 = await bridge.importFromWsh(fingerprint);
      assert.equal(podId1, podId2);
      assert.equal(meshMgr.size, 1);
    });

    it('throws for unknown fingerprint', async () => {
      await assert.rejects(
        () => bridge.importFromWsh('0000000000000000000000000000000000000000000000000000000000000000'),
        /not found in WshKeyStore/
      );
    });

    it('imported identity can sign and verify', async () => {
      const { fingerprint } = await wshStore.generateKey('sign-test', { extractable: true });
      const podId = await bridge.importFromWsh(fingerprint);

      const data = new TextEncoder().encode('bridge test');
      const sig = await meshMgr.sign(podId, data);
      const pubBytes = await meshMgr.getPublicKeyBytes(podId);
      const valid = await meshMgr.verify(pubBytes, data, sig);
      assert.equal(valid, true);
    });
  });

  // -- exportToWsh --------------------------------------------------------

  describe('exportToWsh', () => {
    it('exports a mesh identity to WshKeyStore', async () => {
      const summary = await meshMgr.create('mesh-key');
      const fp = await bridge.exportToWsh(summary.podId);

      assert.equal(typeof fp, 'string');
      assert.equal(fp.length, 64); // hex SHA-256

      // Verify it's in WshKeyStore
      const keys = await wshStore.listKeys();
      assert.ok(keys.some(k => k.fingerprint === fp));
    });

    it('deduplicates: returns existing fingerprint if already exported', async () => {
      const summary = await meshMgr.create('dedup');
      const fp1 = await bridge.exportToWsh(summary.podId);
      const fp2 = await bridge.exportToWsh(summary.podId);
      assert.equal(fp1, fp2);
    });

    it('conversion is consistent with fingerprint2podId', async () => {
      const summary = await meshMgr.create('check');
      const fp = await bridge.exportToWsh(summary.podId);
      const convertedPodId = bridge.fingerprint2podId(fp);
      assert.equal(convertedPodId, summary.podId);
    });
  });

  // -- syncAll ------------------------------------------------------------

  describe('syncAll', () => {
    it('imports from wsh and exports from mesh', async () => {
      // Add a key to WshKeyStore
      const { fingerprint: wshFp } = await wshStore.generateKey('wsh-only', { extractable: true });

      // Add an identity to MeshIdentityManager
      const meshSummary = await meshMgr.create('mesh-only');

      const result = await bridge.syncAll();
      assert.equal(result.imported, 1);
      assert.equal(result.exported, 1);

      // Verify wsh key is now in mesh
      const podId = bridge.fingerprint2podId(wshFp);
      assert.ok(meshMgr.has(podId));

      // Verify mesh identity is now in wsh
      const keys = await wshStore.listKeys();
      const meshFp = bridge.podId2fingerprint(meshSummary.podId);
      assert.ok(keys.some(k => k.fingerprint === meshFp));
    });

    it('does nothing when already synced', async () => {
      const { fingerprint } = await wshStore.generateKey('synced', { extractable: true });
      await bridge.importFromWsh(fingerprint);

      const result = await bridge.syncAll();
      // The imported key should already be in wsh, so only the
      // mesh copy needs exporting (but it came from wsh, so it may
      // deduplicate depending on fingerprint match)
      assert.equal(result.imported, 0);
    });

    it('returns zeros for empty stores', async () => {
      const result = await bridge.syncAll();
      assert.equal(result.imported, 0);
      assert.equal(result.exported, 0);
    });
  });
});
