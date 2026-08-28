/**
 * clawser-identity-wallet.js -- High-level multi-identity wallet.
 *
 * Wraps MeshIdentityManager and IdentitySelector to provide a unified
 * API for identity lifecycle, contact management, and access grants.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-identity-wallet.test.mjs
 */

// ---------------------------------------------------------------------------
// Contact shape
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Contact
 * @property {string} publicKeyHex - Hex-encoded public key
 * @property {string} label - Human-readable name
 * @property {number} trustLevel - Trust in [0.0, 1.0]
 * @property {number} addedAt - Unix timestamp (ms)
 * @property {object} metadata - Arbitrary metadata
 */

/**
 * Create a fresh Contact object.
 *
 * @param {string} publicKeyHex
 * @param {string} label
 * @param {number} [trustLevel=0.5]
 * @returns {Contact}
 */
function createContact(publicKeyHex, label, trustLevel = 0.5) {
  return {
    publicKeyHex,
    label,
    trustLevel: Math.max(0, Math.min(1, trustLevel)),
    addedAt: Date.now(),
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// IdentityWallet
// ---------------------------------------------------------------------------

/**
 * High-level wallet that combines identity management, per-peer identity
 * selection, contact storage, and capability-based access grants.
 */
export class IdentityWallet {
  /** @type {import('./identity.mjs').MeshIdentityManager} */
  #identityManager;

  /** @type {import('./identity.mjs').IdentitySelector|null} */
  #identitySelector;

  /** @type {Map<string, Contact>} publicKeyHex → Contact */
  #contacts = new Map();

  /** @type {Map<string, string[]>} publicKeyHex → granted capability scopes */
  #grants = new Map();

  /** @type {Function} */
  #onLog;

  /**
   * @param {object} opts
   * @param {import('./identity.mjs').MeshIdentityManager} opts.identityManager
   * @param {import('./identity.mjs').IdentitySelector} [opts.identitySelector]
   * @param {Function} [opts.onLog]
   */
  constructor({ identityManager, identitySelector, onLog }) {
    if (!identityManager) {
      throw new Error('identityManager is required');
    }
    this.#identityManager = identityManager;
    this.#identitySelector = identitySelector || null;
    this.#onLog = onLog || (() => {});
  }

  // -----------------------------------------------------------------------
  // Identity CRUD (delegates to identityManager)
  // -----------------------------------------------------------------------

  /**
   * Create a new identity.
   *
   * @param {string} label
   * @param {object} [opts]
   * @returns {Promise<import('./identity.mjs').IdentitySummary>}
   */
  async createIdentity(label, opts) {
    const summary = await this.#identityManager.create(label, opts);
    this.#onLog('wallet:identity:create', { podId: summary.podId, label });
    return summary;
  }

  /**
   * Import an identity from an exported key (JWK).
   *
   * @param {object} exportedKey - JWK private key
   * @param {string} label
   * @param {object} [opts]
   * @returns {Promise<import('./identity.mjs').IdentitySummary>}
   */
  async importIdentity(exportedKey, label, opts) {
    const summary = await this.#identityManager.import(exportedKey, label, opts);
    this.#onLog('wallet:identity:import', { podId: summary.podId, label });
    return summary;
  }

  /**
   * Export an identity as JWK, optionally encrypted with a passphrase.
   *
   * @param {string} podId
   * @param {string} [passphrase]
   * @returns {Promise<object>}
   */
  async exportIdentity(podId, passphrase) {
    return this.#identityManager.export(podId, passphrase);
  }

  /**
   * Delete an identity.
   *
   * @param {string} podId
   * @returns {boolean}
   */
  deleteIdentity(podId) {
    const deleted = this.#identityManager.delete(podId);
    if (deleted) {
      this.#onLog('wallet:identity:delete', { podId });
    }
    return deleted;
  }

  /**
   * List all identity summaries.
   *
   * @returns {import('./identity.mjs').IdentitySummary[]}
   */
  listIdentities() {
    return this.#identityManager.list();
  }

  /**
   * Get a single identity summary.
   *
   * @param {string} podId
   * @returns {import('./identity.mjs').IdentitySummary|null}
   */
  getIdentity(podId) {
    return this.#identityManager.get(podId);
  }

  /**
   * Get the default identity summary.
   *
   * @returns {import('./identity.mjs').IdentitySummary|null}
   */
  getDefault() {
    return this.#identityManager.getDefault();
  }

  /**
   * Set the default identity.
   *
   * @param {string} podId
   */
  setDefault(podId) {
    this.#identityManager.setDefault(podId);
    this.#onLog('wallet:identity:setDefault', { podId });
  }

  // -----------------------------------------------------------------------
  // Per-peer identity selection (delegates to identitySelector)
  // -----------------------------------------------------------------------

  /**
   * Resolve which identity to use for a given peer.
   * Returns null if no selector is configured.
   *
   * @param {string} peerId
   * @returns {import('./packages/mesh-primitives/src/index.mjs').PodIdentity|null}
   */
  selectForPeer(peerId) {
    if (!this.#identitySelector) return null;
    return this.#identitySelector.resolve(peerId);
  }

  /**
   * Set a per-peer identity rule.
   * Throws if no selector is configured.
   *
   * @param {string} peerId
   * @param {string} podId
   */
  setIdentityForPeer(peerId, podId) {
    if (!this.#identitySelector) {
      throw new Error('No IdentitySelector configured');
    }
    this.#identitySelector.setRule(peerId, podId);
    this.#onLog('wallet:selector:set', { peerId, podId });
  }

  /**
   * Remove a per-peer identity rule.
   * Returns false if no selector is configured.
   *
   * @param {string} peerId
   * @returns {boolean}
   */
  removeIdentityForPeer(peerId) {
    if (!this.#identitySelector) return false;
    const removed = this.#identitySelector.removeRule(peerId);
    if (removed) {
      this.#onLog('wallet:selector:remove', { peerId });
    }
    return removed;
  }

  // -----------------------------------------------------------------------
  // Contact management
  // -----------------------------------------------------------------------

  /**
   * Add a contact by their public key hex.
   *
   * @param {string} publicKeyHex
   * @param {string} label
   * @param {number} [trustLevel=0.5]
   * @returns {Contact}
   */
  addContact(publicKeyHex, label, trustLevel = 0.5) {
    if (!publicKeyHex || typeof publicKeyHex !== 'string') {
      throw new Error('publicKeyHex is required and must be a non-empty string');
    }
    if (!label || typeof label !== 'string') {
      throw new Error('label is required and must be a non-empty string');
    }
    if (this.#contacts.has(publicKeyHex)) {
      throw new Error(`Contact already exists: ${publicKeyHex.slice(0, 16)}...`);
    }

    const contact = createContact(publicKeyHex, label, trustLevel);
    this.#contacts.set(publicKeyHex, contact);
    this.#onLog('wallet:contact:add', { publicKeyHex: publicKeyHex.slice(0, 16), label });
    return { ...contact };
  }

  /**
   * Remove a contact and revoke all their access grants.
   *
   * @param {string} publicKeyHex
   * @returns {boolean}
   */
  removeContact(publicKeyHex) {
    const existed = this.#contacts.delete(publicKeyHex);
    if (existed) {
      this.#grants.delete(publicKeyHex);
      this.#onLog('wallet:contact:remove', { publicKeyHex: publicKeyHex.slice(0, 16) });
    }
    return existed;
  }

  /**
   * Get a contact by public key hex.
   *
   * @param {string} publicKeyHex
   * @returns {Contact|null}
   */
  getContact(publicKeyHex) {
    const contact = this.#contacts.get(publicKeyHex);
    return contact ? { ...contact } : null;
  }

  /**
   * List all contacts.
   *
   * @returns {Contact[]}
   */
  listContacts() {
    return [...this.#contacts.values()].map(c => ({ ...c }));
  }

  /**
   * Update a contact's mutable fields (label, trustLevel, metadata).
   *
   * @param {string} publicKeyHex
   * @param {object} updates
   * @param {string} [updates.label]
   * @param {number} [updates.trustLevel]
   * @param {object} [updates.metadata]
   * @returns {Contact|null}
   */
  updateContact(publicKeyHex, updates) {
    const contact = this.#contacts.get(publicKeyHex);
    if (!contact) return null;

    if (updates.label !== undefined) {
      if (typeof updates.label !== 'string' || !updates.label) {
        throw new Error('label must be a non-empty string');
      }
      contact.label = updates.label;
    }
    if (updates.trustLevel !== undefined) {
      contact.trustLevel = Math.max(0, Math.min(1, updates.trustLevel));
    }
    if (updates.metadata !== undefined) {
      contact.metadata = { ...contact.metadata, ...updates.metadata };
    }

    this.#onLog('wallet:contact:update', { publicKeyHex: publicKeyHex.slice(0, 16) });
    return { ...contact };
  }

  // -----------------------------------------------------------------------
  // Access grants
  // -----------------------------------------------------------------------

  /**
   * Grant capability scopes to a contact.
   * Capabilities are additive — duplicates are ignored.
   *
   * @param {string} contactPubKey
   * @param {string[]} capabilities - Scope strings to grant
   */
  grantAccess(contactPubKey, capabilities) {
    if (!this.#contacts.has(contactPubKey)) {
      throw new Error('Contact not found — add the contact first');
    }
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      throw new Error('capabilities must be a non-empty array of strings');
    }

    const existing = this.#grants.get(contactPubKey) || [];
    const merged = [...new Set([...existing, ...capabilities])];
    this.#grants.set(contactPubKey, merged);
    this.#onLog('wallet:grant', {
      publicKeyHex: contactPubKey.slice(0, 16),
      capabilities,
    });
  }

  /**
   * Revoke specific capability scopes from a contact.
   *
   * @param {string} contactPubKey
   * @param {string[]} capabilities - Scope strings to revoke
   */
  revokeAccess(contactPubKey, capabilities) {
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      throw new Error('capabilities must be a non-empty array of strings');
    }

    const existing = this.#grants.get(contactPubKey);
    if (!existing) return;

    const revoked = new Set(capabilities);
    const remaining = existing.filter(c => !revoked.has(c));

    if (remaining.length === 0) {
      this.#grants.delete(contactPubKey);
    } else {
      this.#grants.set(contactPubKey, remaining);
    }
    this.#onLog('wallet:revoke', {
      publicKeyHex: contactPubKey.slice(0, 16),
      capabilities,
    });
  }

  /**
   * Get all granted capability scopes for a contact.
   *
   * @param {string} contactPubKey
   * @returns {string[]}
   */
  getGrantedAccess(contactPubKey) {
    return [...(this.#grants.get(contactPubKey) || [])];
  }

  // -----------------------------------------------------------------------
  // Crypto operations (delegates to identityManager)
  // -----------------------------------------------------------------------

  /**
   * Sign data with a specific identity.
   *
   * @param {string} podId
   * @param {BufferSource} data
   * @returns {Promise<Uint8Array>}
   */
  async sign(podId, data) {
    return this.#identityManager.sign(podId, data);
  }

  /**
   * Verify a signature against a public key (raw bytes).
   *
   * @param {Uint8Array} pubKeyBytes
   * @param {BufferSource} data
   * @param {BufferSource} sig
   * @returns {Promise<boolean>}
   */
  async verify(pubKeyBytes, data, sig) {
    return this.#identityManager.verify(pubKeyBytes, data, sig);
  }

  /**
   * Get the raw public key bytes for an identity.
   *
   * @param {string} podId
   * @returns {Promise<Uint8Array>}
   */
  async getPublicKeyBytes(podId) {
    return this.#identityManager.getPublicKeyBytes(podId);
  }

  // -----------------------------------------------------------------------
  // Persistence helpers
  // -----------------------------------------------------------------------

  /**
   * Number of managed identities.
   *
   * @returns {number}
   */
  get size() {
    return this.#identityManager.size;
  }

  /**
   * Serialize wallet state (contacts, grants, selector rules).
   * Identity data itself is serialized via the identity manager.
   *
   * @returns {object}
   */
  toJSON() {
    const contacts = [];
    for (const c of this.#contacts.values()) {
      contacts.push({ ...c });
    }

    const grants = {};
    for (const [key, caps] of this.#grants) {
      grants[key] = [...caps];
    }

    return {
      contacts,
      grants,
      identities: this.#identityManager.toJSON(),
      selector: this.#identitySelector ? this.#identitySelector.toJSON() : null,
    };
  }

  /**
   * Restore wallet state from serialized data.
   *
   * @param {object} data - Output of toJSON()
   * @param {import('./identity.mjs').MeshIdentityManager} identityManager
   * @param {import('./identity.mjs').IdentitySelector} [identitySelector]
   * @returns {IdentityWallet}
   */
  static fromJSON(data, identityManager, identitySelector) {
    const wallet = new IdentityWallet({
      identityManager,
      identitySelector,
    });

    // Restore contacts
    if (Array.isArray(data?.contacts)) {
      for (const c of data.contacts) {
        if (c.publicKeyHex) {
          wallet.#contacts.set(c.publicKeyHex, {
            publicKeyHex: c.publicKeyHex,
            label: c.label || '',
            trustLevel: typeof c.trustLevel === 'number' ? c.trustLevel : 0.5,
            addedAt: c.addedAt || 0,
            metadata: c.metadata || {},
          });
        }
      }
    }

    // Restore grants
    if (data?.grants && typeof data.grants === 'object') {
      for (const [key, caps] of Object.entries(data.grants)) {
        if (Array.isArray(caps)) {
          wallet.#grants.set(key, [...caps]);
        }
      }
    }

    // Restore selector rules
    if (identitySelector && data?.selector) {
      identitySelector.fromJSON(data.selector);
    }

    return wallet;
  }
}
