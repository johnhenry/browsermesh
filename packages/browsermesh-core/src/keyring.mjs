/**
 * clawser-mesh-keyring.js -- Key hierarchy and linking.
 *
 * Manages parent-child relationships between mesh identities
 * (device, delegate, org, alias, recovery). Provides chain
 * traversal, authority resolution, and expiration pruning.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-keyring.test.mjs
 */

import { encodeBase64url, decodeBase64url } from '@johnhenry/browsermesh-primitives';

// Re-export for consumers
export { encodeBase64url, decodeBase64url };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid relationship types between linked identities. */
export const VALID_RELATIONS = Object.freeze([
  'device',    // Same person, different device
  'delegate',  // Delegated authority
  'org',       // Organization membership
  'alias',     // Alternative identity
  'recovery',  // Recovery key
]);

// ---------------------------------------------------------------------------
// KeyLink
// ---------------------------------------------------------------------------

/**
 * Represents a directed link between two identities.
 *
 * @class
 */
export class KeyLink {
  /**
   * @param {object} opts
   * @param {string} opts.parent - Parent identity pod ID
   * @param {string} opts.child - Child identity pod ID
   * @param {string} opts.relation - One of VALID_RELATIONS
   * @param {string[]|null} [opts.scope] - Optional scope restrictions
   * @param {number|null} [opts.expires] - Optional expiration timestamp (ms)
   * @param {number} [opts.created] - Creation timestamp (ms)
   */
  constructor({ parent, child, relation, scope, expires, created }) {
    /** @type {string} */
    this.parent = parent;
    /** @type {string} */
    this.child = child;
    /** @type {string} */
    this.relation = relation;
    /** @type {string[]|null} */
    this.scope = scope || null;
    /** @type {number|null} */
    this.expires = expires ?? null;
    /** @type {number} */
    this.created = created || Date.now();
  }

  /**
   * Check whether this link has expired.
   *
   * @param {number} [now=Date.now()]
   * @returns {boolean}
   */
  isExpired(now = Date.now()) {
    return this.expires !== null && now >= this.expires;
  }

  /**
   * Serialize to a plain object.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      parent: this.parent,
      child: this.child,
      relation: this.relation,
      scope: this.scope,
      expires: this.expires,
      created: this.created,
    };
  }

  /**
   * Deserialize from a plain object.
   *
   * @param {object} data
   * @returns {KeyLink}
   */
  static fromJSON(data) {
    return new KeyLink(data);
  }
}

// ---------------------------------------------------------------------------
// SignedKeyLink
// ---------------------------------------------------------------------------

/**
 * A KeyLink with cryptographic Ed25519 signatures from both parent and child.
 *
 * The signed payload is canonical JSON over every asserted field —
 * `parent`, `child`, `relation`, `scope`, `expires` and `created` — so a
 * signature that verifies vouches for the delegation's limits, not just for
 * who linked to whom. See {@link SignedKeyLink#signedPayload}.
 */
export class SignedKeyLink extends KeyLink {
  /** @type {Uint8Array|null} */
  parentSignature;

  /** @type {Uint8Array|null} */
  childSignature;

  /**
   * @param {object} opts - KeyLink fields + signatures
   * @param {Uint8Array|null} [opts.parentSignature]
   * @param {Uint8Array|null} [opts.childSignature]
   */
  constructor(opts) {
    super(opts);
    this.parentSignature = opts.parentSignature || null;
    this.childSignature = opts.childSignature || null;
  }

  /**
   * Get the canonical signed payload bytes.
   *
   * Version 2. Covers **every** field the link asserts, including `scope`
   * and `expires`. Version 1 (`parent|child|relation|created`) left those
   * two out, which meant a holder of a signed link could widen its scope
   * and push out its expiry without invalidating either signature — see
   * {@link legacySignedPayload}.
   *
   * JSON is used rather than a delimiter-joined string because `scope`
   * holds caller-supplied strings: `['a|b']` and `['a', 'b']` must not
   * canonicalise to the same bytes. Key order is fixed by the literal, so
   * the encoding is deterministic.
   *
   * @returns {Uint8Array}
   */
  get signedPayload() {
    return new TextEncoder().encode(JSON.stringify({
      v: 2,
      parent: this.parent,
      child: this.child,
      relation: this.relation,
      scope: this.scope,
      expires: this.expires,
      created: this.created,
    }));
  }

  /**
   * The version-1 payload bytes, kept only so links signed before `scope`
   * and `expires` were covered still verify.
   *
   * A v1 signature is accepted **only** when the link carries no scope and
   * no expiry — i.e. when there is nothing v1 failed to cover. A link that
   * has either field must carry a v2 signature over it.
   *
   * @returns {Uint8Array}
   */
  get legacySignedPayload() {
    const str = `${this.parent}|${this.child}|${this.relation}|${this.created}`;
    return new TextEncoder().encode(str);
  }

  /**
   * True when a v1 signature may stand in for a v2 one: the link asserts
   * nothing that the v1 payload left unsigned.
   *
   * @returns {boolean}
   */
  get #legacyAcceptable() {
    return this.scope === null && this.expires === null;
  }

  /**
   * Verify one signature against the canonical payload, falling back to the
   * legacy payload only for links with nothing outside its coverage.
   *
   * @param {CryptoKey} publicKey
   * @param {Uint8Array|null} signature
   * @returns {Promise<boolean>}
   */
  async #verifyOne(publicKey, signature) {
    if (!signature) return false;
    const current = await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      signature,
      this.signedPayload
    );
    if (current) return true;
    if (!this.#legacyAcceptable) return false;
    return crypto.subtle.verify(
      'Ed25519',
      publicKey,
      signature,
      this.legacySignedPayload
    );
  }

  /**
   * Create a signed link between two identities.
   * Both parent and child sign the canonical payload.
   *
   * @param {import('./identity.mjs').PodIdentity} parentIdentity
   * @param {import('./identity.mjs').PodIdentity} childIdentity
   * @param {string} relation - One of VALID_RELATIONS
   * @param {object} [opts]
   * @param {string[]} [opts.scope]
   * @param {number} [opts.expires]
   * @returns {Promise<SignedKeyLink>}
   */
  static async create(parentIdentity, childIdentity, relation, opts = {}) {
    const created = Date.now();
    const link = new SignedKeyLink({
      parent: parentIdentity.podId,
      child: childIdentity.podId,
      relation,
      scope: opts.scope,
      expires: opts.expires,
      created,
    });

    const payload = link.signedPayload;
    link.parentSignature = await parentIdentity.sign(payload);
    link.childSignature = await childIdentity.sign(payload);

    return link;
  }

  /**
   * Verify the parent's signature.
   * @param {CryptoKey} publicKey - Parent's Ed25519 public key
   * @returns {Promise<boolean>}
   */
  async verifyParent(publicKey) {
    return this.#verifyOne(publicKey, this.parentSignature);
  }

  /**
   * Verify the child's signature.
   * @param {CryptoKey} publicKey - Child's Ed25519 public key
   * @returns {Promise<boolean>}
   */
  async verifyChild(publicKey) {
    return this.#verifyOne(publicKey, this.childSignature);
  }

  /**
   * Verify both parent and child signatures.
   * @param {CryptoKey} parentPub - Parent's Ed25519 public key
   * @param {CryptoKey} childPub - Child's Ed25519 public key
   * @returns {Promise<boolean>}
   */
  async verifyBoth(parentPub, childPub) {
    const [parentOk, childOk] = await Promise.all([
      this.verifyParent(parentPub),
      this.verifyChild(childPub),
    ]);
    return parentOk && childOk;
  }

  /**
   * Serialize to a plain object (signatures as base64url).
   * @returns {object}
   */
  toJSON() {
    return {
      ...super.toJSON(),
      parentSignature: this.parentSignature ? encodeBase64url(this.parentSignature) : null,
      childSignature: this.childSignature ? encodeBase64url(this.childSignature) : null,
      signed: true,
    };
  }

  /**
   * Deserialize from a plain object.
   * @param {object} data
   * @returns {SignedKeyLink}
   */
  static fromJSON(data) {
    return new SignedKeyLink({
      ...data,
      parentSignature: data.parentSignature ? decodeBase64url(data.parentSignature) : null,
      childSignature: data.childSignature ? decodeBase64url(data.childSignature) : null,
    });
  }
}

// ---------------------------------------------------------------------------
// SuccessionPolicy
// ---------------------------------------------------------------------------

/** Valid succession actions. */
const VALID_SUCCESSION_ACTIONS = ['transfer', 'revoke', 'notify'];

/**
 * Defines a dead-man's-switch policy: if `primaryId` is inactive
 * longer than `inactivityThresholdMs`, the chosen action fires.
 *
 * @class
 */
export class SuccessionPolicy {
  /**
   * @param {object} opts
   * @param {string} opts.primaryId - Identity that must remain active
   * @param {string} opts.successorId - Identity that takes over
   * @param {number} opts.inactivityThresholdMs - Inactivity window (ms)
   * @param {'transfer'|'revoke'|'notify'} [opts.action='transfer']
   * @param {number} [opts.createdAt]
   */
  constructor({ primaryId, successorId, inactivityThresholdMs, action = 'transfer', createdAt }) {
    if (!primaryId) throw new Error('primaryId is required');
    if (!successorId) throw new Error('successorId is required');
    if (typeof inactivityThresholdMs !== 'number' || inactivityThresholdMs <= 0) {
      throw new Error('inactivityThresholdMs must be a positive number');
    }
    if (!VALID_SUCCESSION_ACTIONS.includes(action)) {
      throw new Error(
        `Invalid action: ${action}. Must be one of: ${VALID_SUCCESSION_ACTIONS.join(', ')}`
      );
    }
    this.primaryId = primaryId;
    this.successorId = successorId;
    this.inactivityThresholdMs = inactivityThresholdMs;
    this.action = action;
    this.createdAt = createdAt ?? Date.now();
  }

  /**
   * Whether the switch is armed (primary has been inactive too long).
   *
   * @param {number} [now=Date.now()]
   * @param {number|undefined} lastActive - Last activity timestamp
   * @returns {boolean}
   */
  isArmed(now = Date.now(), lastActive) {
    if (lastActive === undefined || lastActive === null) return true;
    return (now - lastActive) >= this.inactivityThresholdMs;
  }

  /**
   * Serialize to a plain object.
   * @returns {object}
   */
  toJSON() {
    return {
      primaryId: this.primaryId,
      successorId: this.successorId,
      inactivityThresholdMs: this.inactivityThresholdMs,
      action: this.action,
      createdAt: this.createdAt,
    };
  }

  /**
   * Deserialize from a plain object.
   * @param {object} data
   * @returns {SuccessionPolicy}
   */
  static fromJSON(data) {
    return new SuccessionPolicy(data);
  }
}

// ---------------------------------------------------------------------------
// MeshKeyring
// ---------------------------------------------------------------------------

/**
 * Manages a graph of KeyLink relationships between identities.
 *
 * @class
 */
export class MeshKeyring {
  /** @type {KeyLink[]} */
  #links = [];

  /** @type {*} */
  #storage;

  /** @type {Map<string, SuccessionPolicy>} primaryId -> policy */
  #successions = new Map();

  /** @type {Map<string, number>} podId -> lastActiveTimestamp */
  #activityLog = new Map();

  /**
   * @param {object} [opts]
   * @param {*} [opts.storage] - Optional persistence adapter
   */
  constructor(opts = {}) {
    this.#storage = opts.storage || null;
  }

  // -- Link management ----------------------------------------------------

  /**
   * Create a link from parent to child with the given relation.
   *
   * @param {string} parentId - Parent identity pod ID
   * @param {string} childId - Child identity pod ID
   * @param {string} relation - One of VALID_RELATIONS
   * @param {object} [opts]
   * @param {string[]} [opts.scope] - Scope restrictions
   * @param {number} [opts.expires] - Expiration timestamp (ms)
   * @returns {KeyLink}
   */
  link(parentId, childId, relation, opts = {}) {
    if (!VALID_RELATIONS.includes(relation)) {
      throw new Error(
        `Invalid relation: ${relation}. Must be one of: ${VALID_RELATIONS.join(', ')}`
      );
    }
    if (parentId === childId) {
      throw new Error('Cannot link identity to itself');
    }
    const existing = this.#links.find(
      (l) => l.parent === parentId && l.child === childId
    );
    if (existing) {
      throw new Error(`Link already exists: ${parentId} -> ${childId}`);
    }

    const link = new KeyLink({
      parent: parentId,
      child: childId,
      relation,
      scope: opts.scope,
      expires: opts.expires,
    });
    this.#links.push(link);
    return link;
  }

  /**
   * Remove a link between parent and child.
   *
   * @param {string} parentId
   * @param {string} childId
   * @returns {boolean} true if a link was removed
   */
  unlink(parentId, childId) {
    const idx = this.#links.findIndex(
      (l) => l.parent === parentId && l.child === childId
    );
    if (idx === -1) return false;
    this.#links.splice(idx, 1);
    return true;
  }

  // -- Chain traversal ----------------------------------------------------

  /**
   * Walk up the link chain from `id` towards the root.
   * Returns the ordered list of KeyLinks from child to root.
   *
   * @param {string} id - Starting identity pod ID
   * @returns {KeyLink[]}
   */
  getChain(id) {
    const chain = [];
    let current = id;
    const visited = new Set();
    while (true) {
      if (visited.has(current)) break; // cycle guard
      visited.add(current);
      const link = this.#links.find((l) => l.child === current);
      if (!link) break;
      chain.push(link);
      current = link.parent;
    }
    return chain;
  }

  /**
   * Get all direct children of an identity.
   *
   * @param {string} id
   * @returns {KeyLink[]}
   */
  getChildren(id) {
    return this.#links.filter((l) => l.parent === id);
  }

  /**
   * Get the direct parent link of an identity (or null).
   *
   * @param {string} id
   * @returns {KeyLink|null}
   */
  getParent(id) {
    return this.#links.find((l) => l.child === id) || null;
  }

  /**
   * Check whether `descendantId` is a descendant of `ancestorId`.
   *
   * @param {string} ancestorId
   * @param {string} descendantId
   * @returns {boolean}
   */
  isDescendant(ancestorId, descendantId) {
    const chain = this.getChain(descendantId);
    return chain.some((l) => l.parent === ancestorId);
  }

  /**
   * Walk to the root of the chain and return the root identity ID.
   *
   * @param {string} id
   * @returns {string} The root (ultimate authority) pod ID
   */
  resolveAuthority(id) {
    const chain = this.getChain(id);
    return chain.length > 0 ? chain[chain.length - 1].parent : id;
  }

  /**
   * Verify a chain for expiration.
   *
   * @param {KeyLink[]} chain
   * @param {number} [now=Date.now()]
   * @returns {{ valid: boolean, depth: number, expired: KeyLink[] }}
   */
  verifyChain(chain, now = Date.now()) {
    let valid = true;
    const expired = [];
    for (const link of chain) {
      if (link.isExpired(now)) {
        valid = false;
        expired.push(link);
      }
    }
    return { valid, depth: chain.length, expired };
  }

  // -- Signed link support ------------------------------------------------

  /**
   * Add a signed link after verifying its signatures.
   *
   * @param {SignedKeyLink} signedLink
   * @param {CryptoKey} parentPub - Parent's Ed25519 public key
   * @param {CryptoKey} childPub - Child's Ed25519 public key
   * @returns {Promise<SignedKeyLink>}
   */
  async addVerifiedLink(signedLink, parentPub, childPub) {
    if (!(signedLink instanceof SignedKeyLink)) {
      throw new Error('Expected a SignedKeyLink instance');
    }
    if (!VALID_RELATIONS.includes(signedLink.relation)) {
      throw new Error(`Invalid relation: ${signedLink.relation}`);
    }
    if (signedLink.parent === signedLink.child) {
      throw new Error('Cannot link identity to itself');
    }

    const valid = await signedLink.verifyBoth(parentPub, childPub);
    if (!valid) {
      throw new Error('Signature verification failed');
    }

    const existing = this.#links.find(
      (l) => l.parent === signedLink.parent && l.child === signedLink.child
    );
    if (existing) {
      throw new Error(`Link already exists: ${signedLink.parent} -> ${signedLink.child}`);
    }

    this.#links.push(signedLink);
    return signedLink;
  }

  /**
   * Verify an entire chain cryptographically (signatures + expiration).
   *
   * @param {string} fromId - Starting identity (leaf)
   * @param {string} toId - Target identity (root/ancestor)
   * @param {Function} getPublicKey - async (podId) => CryptoKey
   * @returns {Promise<{valid: boolean, chain: KeyLink[], brokenAt?: string}>}
   */
  async verifyCryptoChain(fromId, toId, getPublicKey) {
    const chain = this.getChain(fromId);
    const relevantChain = [];

    // Walk chain until we reach toId
    let found = false;
    for (const link of chain) {
      relevantChain.push(link);
      if (link.parent === toId) {
        found = true;
        break;
      }
    }

    if (!found) {
      return { valid: false, chain: relevantChain, brokenAt: 'no-path' };
    }

    // Verify each link in the chain
    for (const link of relevantChain) {
      if (link.isExpired()) {
        return { valid: false, chain: relevantChain, brokenAt: link.child };
      }

      if (link instanceof SignedKeyLink) {
        try {
          const parentPub = await getPublicKey(link.parent);
          const childPub = await getPublicKey(link.child);
          const ok = await link.verifyBoth(parentPub, childPub);
          if (!ok) {
            return { valid: false, chain: relevantChain, brokenAt: link.child };
          }
        } catch {
          return { valid: false, chain: relevantChain, brokenAt: link.child };
        }
      }
    }

    return { valid: true, chain: relevantChain };
  }

  // -- Succession / Dead Man's Switch -------------------------------------

  /**
   * Register a succession policy for a primary identity.
   *
   * @param {string} primaryId - Identity that must remain active
   * @param {string} successorId - Identity that takes over
   * @param {number} thresholdMs - Inactivity threshold in milliseconds
   * @param {'transfer'|'revoke'|'notify'} [action='transfer']
   * @returns {SuccessionPolicy}
   */
  setSuccessor(primaryId, successorId, thresholdMs, action = 'transfer') {
    const policy = new SuccessionPolicy({
      primaryId,
      successorId,
      inactivityThresholdMs: thresholdMs,
      action,
    });
    this.#successions.set(primaryId, policy);
    return policy;
  }

  /**
   * Remove a succession policy.
   *
   * @param {string} primaryId
   * @returns {boolean} true if a policy was removed
   */
  removeSuccessor(primaryId) {
    return this.#successions.delete(primaryId);
  }

  /**
   * Record activity for a pod identity (resets the dead-man timer).
   *
   * @param {string} podId
   */
  recordActivity(podId) {
    this.#activityLog.set(podId, Date.now());
  }

  /**
   * Check all succession policies and return those that are armed.
   *
   * @param {number} [now=Date.now()]
   * @returns {{ policy: SuccessionPolicy, lastActive: number|undefined }[]}
   */
  checkSuccession(now = Date.now()) {
    const armed = [];
    for (const policy of this.#successions.values()) {
      const lastActive = this.#activityLog.get(policy.primaryId);
      if (policy.isArmed(now, lastActive)) {
        armed.push({ policy, lastActive });
      }
    }
    return armed;
  }

  /**
   * Execute a succession policy for the given primary identity.
   *
   * - **transfer**: re-links all children of primaryId to successorId,
   *   removes old links.
   * - **revoke**: removes all child links of primaryId.
   * - **notify**: returns a notification signal without modifying links.
   *
   * The policy is removed after execution.
   *
   * @param {string} primaryId
   * @returns {{ action: string, primaryId: string, successorId: string, affected: number }}
   */
  executeSuccession(primaryId) {
    const policy = this.#successions.get(primaryId);
    if (!policy) {
      throw new Error(`No succession policy for: ${primaryId}`);
    }

    const children = this.getChildren(primaryId);
    let affected = 0;

    if (policy.action === 'transfer') {
      for (const child of children) {
        this.unlink(primaryId, child.child);
        // Only re-link if it won't create a self-link or duplicate
        if (policy.successorId !== child.child) {
          const existing = this.#links.find(
            (l) => l.parent === policy.successorId && l.child === child.child
          );
          if (!existing) {
            this.link(policy.successorId, child.child, child.relation, {
              scope: child.scope || undefined,
              expires: child.expires || undefined,
            });
          }
        }
        affected++;
      }
    } else if (policy.action === 'revoke') {
      for (const child of children) {
        this.unlink(primaryId, child.child);
        affected++;
      }
    } else if (policy.action === 'notify') {
      affected = children.length;
    }

    this.#successions.delete(primaryId);

    return {
      action: policy.action,
      primaryId: policy.primaryId,
      successorId: policy.successorId,
      affected,
    };
  }

  // -- Maintenance --------------------------------------------------------

  /**
   * Remove all expired links.
   *
   * @param {number} [now=Date.now()]
   * @returns {number} Number of links pruned
   */
  pruneExpired(now = Date.now()) {
    const before = this.#links.length;
    this.#links = this.#links.filter((l) => !l.isExpired(now));
    return before - this.#links.length;
  }

  /** @returns {number} */
  get size() {
    return this.#links.length;
  }

  /**
   * Return a copy of all links.
   *
   * @returns {KeyLink[]}
   */
  listLinks() {
    return [...this.#links];
  }

  // -- Serialization ------------------------------------------------------

  /**
   * Serialize all links.
   *
   * @returns {object[]}
   */
  toJSON() {
    return this.#links.map((l) => l.toJSON());
  }

  /**
   * Deserialize from an array of link data.
   *
   * @param {object[]} data
   * @returns {MeshKeyring}
   */
  static fromJSON(data) {
    const kr = new MeshKeyring();
    for (const d of data) {
      /*
       * Dispatch on the serialised shape. Reviving everything through
       * `KeyLink.fromJSON` returned a plain KeyLink for signed links too, and
       * `verifyCryptoChain` only checks a signature `if (link instanceof
       * SignedKeyLink)` -- so every restored keyring reported `valid: true`
       * having called `getPublicKey` zero times.
       *
       * The signatures were never lost; they survive serialisation intact.
       * Only the CLASS was, and the class is what the check keys on. So a
       * keyring that had been persisted, sent to a peer, or reloaded from
       * disk verified without any cryptography at all.
       */
      kr.#links.push(
        d && (d.parentSignature || d.childSignature || d.signed)
          ? SignedKeyLink.fromJSON(d)
          : KeyLink.fromJSON(d)
      );
    }
    return kr;
  }
}
