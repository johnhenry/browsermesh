/**
// STATUS: implemented + unit-tested (clawser-mesh-wsh-bridge.test.mjs), but
// never instantiated in app code — `import { MeshWshBridge }` in
// clawser-pod.js has no matching `new MeshWshBridge(...)` call site anywhere.
// Not a functional replacement for clawser-kernel-wsh-bridge.js despite the
// similar name and shared mention in docs/data/networking.yaml's "WSH Bridge
// Deprecation" entry — this bridges identity key *formats*, not wsh session
// tenant/capability routing.
 * clawser-mesh-wsh-bridge.js -- Bridge between WshKeyStore and MeshIdentityManager.
 *
 * WshKeyStore uses hex-encoded SHA-256 fingerprints.
 * MeshIdentityManager uses base64url-encoded SHA-256 pod IDs.
 * Both hash the same raw Ed25519 public key bytes with SHA-256.
 *
 * This bridge converts between the two formats and syncs keys.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-wsh-bridge.test.mjs
 */

import {
  derivePodId,
  encodeBase64url,
  decodeBase64url,
} from '@johnhenry/browsermesh-primitives';

// ---------------------------------------------------------------------------
// Hex <-> Base64url conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert hex string to Uint8Array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// MeshWshBridge
// ---------------------------------------------------------------------------

/**
 * Bridges WshKeyStore (hex fingerprints) with MeshIdentityManager (base64url pod IDs).
 *
 * Both systems use SHA-256 of the raw Ed25519 public key as their identifier,
 * but encode it differently: WshKeyStore uses lowercase hex, MeshIdentityManager
 * uses base64url (no padding).
 */
export class MeshWshBridge {
  /** @type {import('./packages/wsh/src/keystore.mjs').WshKeyStore} */
  #wshKeyStore;

  /** @type {import('./clawser-mesh-identity.js').MeshIdentityManager} */
  #meshIdentityManager;

  /**
   * @param {*} wshKeyStore
   * @param {*} meshIdentityManager
   */
  constructor(wshKeyStore, meshIdentityManager) {
    if (!wshKeyStore) throw new Error('wshKeyStore is required');
    if (!meshIdentityManager) throw new Error('meshIdentityManager is required');
    this.#wshKeyStore = wshKeyStore;
    this.#meshIdentityManager = meshIdentityManager;
  }

  /**
   * Convert a hex fingerprint to a base64url pod ID.
   * Both are SHA-256 of the same raw public key, just different encodings.
   * @param {string} hex - Hex-encoded SHA-256 fingerprint
   * @returns {string} Base64url-encoded pod ID
   */
  fingerprint2podId(hex) {
    const bytes = hexToBytes(hex);
    return encodeBase64url(bytes);
  }

  /**
   * Convert a base64url pod ID to a hex fingerprint.
   * @param {string} b64url - Base64url-encoded pod ID
   * @returns {string} Hex-encoded fingerprint
   */
  podId2fingerprint(b64url) {
    const bytes = decodeBase64url(b64url);
    return bytesToHex(bytes);
  }

  /**
   * Import a key from WshKeyStore into MeshIdentityManager.
   * @param {string} fingerprint - Hex fingerprint from WshKeyStore
   * @returns {Promise<string>} The pod ID of the imported identity
   */
  async importFromWsh(fingerprint) {
    // Check if already imported
    const podId = this.fingerprint2podId(fingerprint);
    if (this.#meshIdentityManager.has(podId)) {
      return podId;
    }

    // Find the key in WshKeyStore by listing and matching fingerprint
    const keys = await this.#wshKeyStore.listKeys();
    const entry = keys.find(k => k.fingerprint === fingerprint);
    if (!entry) {
      throw new Error(`Key with fingerprint ${fingerprint} not found in WshKeyStore`);
    }

    // Get the full key pair
    const keyPair = await this.#wshKeyStore.getKeyPair(entry.name);

    // Export private key as JWK for mesh import
    const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

    const summary = await this.#meshIdentityManager.import(jwk, `wsh:${entry.name}`, {
      metadata: { source: 'wsh', wshName: entry.name, wshFingerprint: fingerprint },
    });

    return summary.podId;
  }

  /**
   * Export an identity from MeshIdentityManager to WshKeyStore.
   * @param {string} podId - Base64url pod ID
   * @returns {Promise<string>} The hex fingerprint in WshKeyStore
   */
  async exportToWsh(podId) {
    const fp = this.podId2fingerprint(podId);

    // Check if already in WshKeyStore
    const keys = await this.#wshKeyStore.listKeys();
    const existing = keys.find(k => k.fingerprint === fp);
    if (existing) {
      return fp;
    }

    // Export from mesh as JWK
    const jwk = await this.#meshIdentityManager.export(podId);

    // Import into WshKeyStore
    // WshKeyStore expects raw key import, but we have JWK
    // We'll import via crypto.subtle first, then use WshKeyStore's generateKey pattern
    const summary = this.#meshIdentityManager.get(podId);
    const name = `mesh:${summary?.label || podId.slice(0, 8)}`;

    // Import the private key as extractable
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'Ed25519' },
      true,
      ['sign']
    );

    // Derive public key
    const pubJwk = { ...jwk };
    delete pubJwk.d;
    pubJwk.key_ops = ['verify'];
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      pubJwk,
      { name: 'Ed25519' },
      true,
      ['verify']
    );

    // Store directly in WshKeyStore's internal DB
    // We need to use the _put method or store via the keystore's approach
    // Since WshKeyStore doesn't have a direct import method, we'll use its internal _put
    if (typeof this.#wshKeyStore._put === 'function') {
      await this.#wshKeyStore._ensureDb();
      await this.#wshKeyStore._put({
        name,
        publicKey,
        privateKey,
        createdAt: Date.now(),
        fingerprint: fp,
      });
    } else {
      throw new Error('WshKeyStore does not support direct key import');
    }

    return fp;
  }

  /**
   * Sync all keys between both stores.
   * Imports from WshKeyStore into Mesh that don't exist in Mesh,
   * and exports from Mesh to WshKeyStore that don't exist in Wsh.
   * @returns {Promise<{imported: number, exported: number}>}
   */
  async syncAll() {
    let imported = 0;
    let exported = 0;

    // Import from Wsh -> Mesh
    const wshKeys = await this.#wshKeyStore.listKeys();
    for (const key of wshKeys) {
      const podId = this.fingerprint2podId(key.fingerprint);
      if (!this.#meshIdentityManager.has(podId)) {
        try {
          await this.importFromWsh(key.fingerprint);
          imported++;
        } catch {
          // Skip keys that fail to import (e.g., non-extractable)
        }
      }
    }

    // Export from Mesh -> Wsh
    const meshIds = this.#meshIdentityManager.list();
    for (const id of meshIds) {
      const fp = this.podId2fingerprint(id.podId);
      const existing = wshKeys.find(k => k.fingerprint === fp);
      if (!existing) {
        try {
          await this.exportToWsh(id.podId);
          exported++;
        } catch {
          // Skip keys that fail to export
        }
      }
    }

    return { imported, exported };
  }
}

export { hexToBytes, bytesToHex };
