/**
 * clawser-mesh-keyring.js -- Key hierarchy and linking.
 *
 * Manages parent-child relationships between mesh identities
 * (device, delegate, org, alias, recovery). Provides chain
 * traversal, authority resolution, signed revocation and expiration
 * pruning.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./test/_setup-globals.mjs --test test/keyring.test.mjs
 */

import { encodeBase64url, decodeBase64url } from '@johnhenry/browsermesh-primitives';
import { domainPayload } from './canonical.mjs';

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

/** Domain prefix of the bytes a {@link SignedKeyLink} signs (version 3). */
export const KEYLINK_DOMAIN = 'browsermesh/keylink/v3\n';

/** Domain prefix of the bytes a {@link SignedKeyUnlink} signs. */
export const KEYUNLINK_DOMAIN = 'browsermesh/keyunlink/v1\n';

// ---------------------------------------------------------------------------
// KeyLink
// ---------------------------------------------------------------------------

/**
 * Represents a directed link between two identities.
 *
 * A bare `KeyLink` carries no signatures: it is a local assertion only.
 * {@link MeshKeyring#verifyCryptoChain} refuses it by default.
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
   * @param {string|null} [opts.namespace] - Keyring/context the link belongs to
   */
  constructor({ parent, child, relation, scope, expires, created, namespace }) {
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
    /** @type {string|null} */
    this.namespace = namespace ?? null;
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
      namespace: this.namespace,
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
 * Both parties sign `"browsermesh/keylink/v3\n" ‖ canonical(body)`, where
 * `body` holds every asserted field — `parent`, `child`, `relation`,
 * `scope`, `expires`, `created` and `namespace` — and `canonical` is JSON
 * with sorted keys. See {@link SignedKeyLink#signedPayload}.
 *
 * Earlier payload versions:
 * - v1 (`parent|child|relation|created`) is no longer accepted at all.
 * - v2 (literal-order JSON with `v: 2`, no prefix, no namespace) verifies
 *   only when the caller opts in with `acceptLegacyV2: true`, and only for
 *   links with no namespace. New links are always signed with v3; re-sign
 *   old ones with {@link SignedKeyLink#resign}.
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
   * The canonical signed payload bytes (version 3).
   *
   * `"browsermesh/keylink/v3\n"` followed by sorted-key canonical JSON of
   * every field the link asserts. The prefix keeps a link signature from
   * being replayed as any other signed browsermesh message; `namespace`
   * keeps a link minted for one keyring from being valid in another.
   *
   * @returns {Uint8Array}
   */
  get signedPayload() {
    return domainPayload(KEYLINK_DOMAIN, {
      parent: this.parent,
      child: this.child,
      relation: this.relation,
      scope: this.scope,
      expires: this.expires,
      created: this.created,
      namespace: this.namespace,
    });
  }

  /**
   * The version-2 payload bytes (browsermesh-core 0.5–0.9), kept only so
   * persisted links can be verified during a migration when the caller
   * explicitly passes `acceptLegacyV2: true`. Never used for signing.
   *
   * @returns {Uint8Array}
   */
  get legacyV2SignedPayload() {
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
   * Verify one signature against the v3 payload, or — only when opted in
   * and the link has no namespace (v2 could not bind one) — the v2 payload.
   *
   * @param {CryptoKey} publicKey
   * @param {Uint8Array|null} signature
   * @param {{ acceptLegacyV2?: boolean }} [opts]
   * @returns {Promise<boolean>}
   */
  async #verifyOne(publicKey, signature, { acceptLegacyV2 = false } = {}) {
    if (!signature) return false;
    if (await crypto.subtle.verify('Ed25519', publicKey, signature, this.signedPayload)) {
      return true;
    }
    if (!acceptLegacyV2 || this.namespace !== null) return false;
    return crypto.subtle.verify('Ed25519', publicKey, signature, this.legacyV2SignedPayload);
  }

  /**
   * Create a signed link between two identities.
   * Both parent and child sign the canonical v3 payload.
   *
   * @param {import('./identity.mjs').PodIdentity} parentIdentity
   * @param {import('./identity.mjs').PodIdentity} childIdentity
   * @param {string} relation - One of VALID_RELATIONS
   * @param {object} [opts]
   * @param {string[]} [opts.scope]
   * @param {number} [opts.expires]
   * @param {string} [opts.namespace] - Keyring/context this link is valid in
   * @param {number} [opts.created] - Creation timestamp (defaults to now)
   * @returns {Promise<SignedKeyLink>}
   */
  static async create(parentIdentity, childIdentity, relation, opts = {}) {
    const link = new SignedKeyLink({
      parent: parentIdentity.podId,
      child: childIdentity.podId,
      relation,
      scope: opts.scope,
      expires: opts.expires,
      namespace: opts.namespace,
      created: opts.created ?? Date.now(),
    });

    const payload = link.signedPayload;
    link.parentSignature = await parentIdentity.sign(payload);
    link.childSignature = await childIdentity.sign(payload);

    return link;
  }

  /**
   * Re-sign this link's fields with the current (v3) payload, e.g. to
   * migrate a persisted v2 link. Needs both private keys. `created` is kept;
   * `namespace` may be set (a v2 link had none).
   *
   * @param {import('./identity.mjs').PodIdentity} parentIdentity
   * @param {import('./identity.mjs').PodIdentity} childIdentity
   * @param {{ namespace?: string|null }} [opts]
   * @returns {Promise<SignedKeyLink>} A new link; this one is unchanged.
   */
  async resign(parentIdentity, childIdentity, opts = {}) {
    if (parentIdentity.podId !== this.parent || childIdentity.podId !== this.child) {
      throw new Error('resign() needs the identities of this link\'s parent and child');
    }
    return SignedKeyLink.create(parentIdentity, childIdentity, this.relation, {
      scope: this.scope || undefined,
      expires: this.expires ?? undefined,
      namespace: 'namespace' in opts ? opts.namespace : this.namespace,
      created: this.created,
    });
  }

  /**
   * Which payload version both signatures verify under: `3`, `2` (legacy,
   * needs migration), or `null` (neither). Useful for migration tooling.
   *
   * @param {CryptoKey} parentPub
   * @param {CryptoKey} childPub
   * @returns {Promise<3|2|null>}
   */
  async signatureVersion(parentPub, childPub) {
    if (await this.verifyBoth(parentPub, childPub)) return 3;
    if (await this.verifyBoth(parentPub, childPub, { acceptLegacyV2: true })) return 2;
    return null;
  }

  /**
   * Verify the parent's signature.
   * @param {CryptoKey} publicKey - Parent's Ed25519 public key
   * @param {{ acceptLegacyV2?: boolean }} [opts]
   * @returns {Promise<boolean>}
   */
  async verifyParent(publicKey, opts) {
    return this.#verifyOne(publicKey, this.parentSignature, opts);
  }

  /**
   * Verify the child's signature.
   * @param {CryptoKey} publicKey - Child's Ed25519 public key
   * @param {{ acceptLegacyV2?: boolean }} [opts]
   * @returns {Promise<boolean>}
   */
  async verifyChild(publicKey, opts) {
    return this.#verifyOne(publicKey, this.childSignature, opts);
  }

  /**
   * Verify both parent and child signatures.
   * @param {CryptoKey} parentPub - Parent's Ed25519 public key
   * @param {CryptoKey} childPub - Child's Ed25519 public key
   * @param {{ acceptLegacyV2?: boolean }} [opts]
   * @returns {Promise<boolean>}
   */
  async verifyBoth(parentPub, childPub, opts) {
    const [parentOk, childOk] = await Promise.all([
      this.verifyParent(parentPub, opts),
      this.verifyChild(childPub, opts),
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
// SignedKeyUnlink
// ---------------------------------------------------------------------------

/**
 * A signed, transferable revocation of the `parent -> child` edge.
 *
 * The parent signs `"browsermesh/keyunlink/v1\n" ‖ canonical(body)` over
 * `parent`, `child`, `namespace`, `created`, `reason` and, only when set,
 * `expires`. It revokes every
 * link on that edge (in that namespace) created at or before `created`, so
 * a re-link signed later by both parties is not affected, but replaying the
 * old link is. Because authority flows down the chain, every descendant of
 * `child` loses whatever authority it derived through the revoked edge.
 *
 * Unlike {@link MeshKeyring#unlink} (local only), an unlink can be relayed
 * to peers and applied with {@link MeshKeyring#applyUnlink}.
 */
export class SignedKeyUnlink {
  /**
   * @param {object} opts
   * @param {string} opts.parent
   * @param {string} opts.child
   * @param {string|null} [opts.namespace]
   * @param {number} [opts.created]
   * @param {string|null} [opts.reason]
   * @param {number|null} [opts.expires] - Optional expiry (ms epoch, same
   *   convention as `KeyLink#expires`), covered by the signature. After it
   *   the revocation is dropped by the keyring.
   * @param {Uint8Array|null} [opts.signature]
   */
  constructor({ parent, child, namespace, created, reason, expires, signature }) {
    if (!parent || !child) throw new Error('parent and child are required');
    if (expires != null && !Number.isFinite(expires)) {
      throw new TypeError('expires must be a finite number (ms epoch)');
    }
    this.expires = expires ?? null;
    this.parent = parent;
    this.child = child;
    this.namespace = namespace ?? null;
    this.created = created || Date.now();
    this.reason = reason ?? null;
    this.signature = signature || null;
  }

  /**
   * Signed bytes. `expires` is part of the canonical body only when set
   * (canonical JSON omits `undefined`), so an unlink without it signs the
   * exact bytes it always did. The domain stays `keyunlink/v1`: the body is
   * self-describing (a present `expires` key changes the bytes, and removing
   * it from a signed unlink breaks the signature), so a downgrade or
   * re-interpretation is impossible and a v2 string would only orphan every
   * existing unlink.
   *
   * @returns {Uint8Array}
   */
  get signedPayload() {
    return domainPayload(KEYUNLINK_DOMAIN, {
      parent: this.parent,
      child: this.child,
      namespace: this.namespace,
      created: this.created,
      reason: this.reason,
      expires: this.expires ?? undefined,
    });
  }

  /**
   * Whether this unlink's expiry has passed (`now >= expires`, as for links).
   * @param {number} [now=Date.now()]
   * @returns {boolean}
   */
  isExpired(now = Date.now()) {
    return this.expires !== null && now >= this.expires;
  }

  /**
   * Create an unlink signed by the parent.
   *
   * @param {import('./identity.mjs').PodIdentity} parentIdentity
   * @param {string} childId
   * @param {{ namespace?: string, reason?: string, created?: number, expires?: number }} [opts]
   * @returns {Promise<SignedKeyUnlink>}
   */
  static async create(parentIdentity, childId, opts = {}) {
    const unlink = new SignedKeyUnlink({
      parent: parentIdentity.podId,
      child: childId,
      namespace: opts.namespace,
      created: opts.created ?? Date.now(),
      reason: opts.reason,
      expires: opts.expires,
    });
    unlink.signature = await parentIdentity.sign(unlink.signedPayload);
    return unlink;
  }

  /**
   * Create an unlink for a known link: same child and namespace, and
   * `expires` set to the link's expiry (none if the link never expires), so
   * the revocation lives exactly as long as the link it revokes. `opts` may
   * override `expires`, `reason` and `created`.
   *
   * @param {import('./identity.mjs').PodIdentity} parentIdentity
   * @param {KeyLink} link
   * @param {{ reason?: string, created?: number, expires?: number|null }} [opts]
   * @returns {Promise<SignedKeyUnlink>}
   */
  static async forLink(parentIdentity, link, opts = {}) {
    if (link.parent !== parentIdentity.podId) {
      throw new Error('Link was not issued by this parent');
    }
    return SignedKeyUnlink.create(parentIdentity, link.child, {
      namespace: link.namespace ?? undefined,
      reason: opts.reason,
      created: Math.max(opts.created ?? Date.now(), link.created),
      expires: 'expires' in opts ? (opts.expires ?? undefined) : (link.expires ?? undefined),
    });
  }

  /**
   * Verify the parent's signature.
   * @param {CryptoKey} parentPub
   * @returns {Promise<boolean>}
   */
  async verify(parentPub) {
    if (!this.signature) return false;
    return crypto.subtle.verify('Ed25519', parentPub, this.signature, this.signedPayload);
  }

  /**
   * Whether this unlink revokes `link` (same edge and namespace, and the
   * link was created at or before the unlink).
   *
   * @param {KeyLink} link
   * @returns {boolean}
   */
  revokes(link) {
    return link.parent === this.parent &&
      link.child === this.child &&
      (link.namespace ?? null) === this.namespace &&
      link.created <= this.created;
  }

  toJSON() {
    return {
      type: 'unlink',
      parent: this.parent,
      child: this.child,
      namespace: this.namespace,
      created: this.created,
      reason: this.reason,
      ...(this.expires !== null ? { expires: this.expires } : {}),
      signature: this.signature ? encodeBase64url(this.signature) : null,
    };
  }

  /**
   * @param {object} data
   * @returns {SignedKeyUnlink}
   */
  static fromJSON(data) {
    return new SignedKeyUnlink({
      ...data,
      signature: data.signature ? decodeBase64url(data.signature) : null,
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
 * Whether `child` scope is no wider than `parent` scope (null = unrestricted).
 * @param {string[]|null} parent
 * @param {string[]|null} child
 */
function scopeNarrows(parent, child) {
  if (parent === null) return true;
  if (child === null) return false;
  return child.every((s) => parent.includes(s));
}

/**
 * Whether `child` expiry is no later than `parent` expiry (null = never).
 * @param {number|null} parent
 * @param {number|null} child
 */
function expiresNarrows(parent, child) {
  if (parent === null) return true;
  if (child === null) return false;
  return child <= parent;
}

/**
 * Manages a graph of KeyLink relationships between identities.
 *
 * A keyring may be bound to a `namespace` (any string naming the context:
 * an account, an app, a mesh). Signed links and unlinks carry the namespace
 * inside their signature, and the keyring only accepts ones whose namespace
 * equals its own (`null` matches only `null`), so a link issued for one
 * keyring cannot be replayed into another.
 *
 * @class
 */
export class MeshKeyring {
  /** @type {KeyLink[]} */
  #links = [];

  /** @type {SignedKeyUnlink[]} */
  #revocations = [];

  /** @type {*} */
  #storage;

  /** @type {string|null} */
  #namespace;

  /** @type {boolean} */
  #acceptLegacyV2;

  /** @type {Map<string, SuccessionPolicy>} primaryId -> policy */
  #successions = new Map();

  /** @type {Map<string, number>} podId -> lastActiveTimestamp */
  #activityLog = new Map();

  /**
   * @param {object} [opts]
   * @param {*} [opts.storage] - Optional persistence adapter
   * @param {string|null} [opts.namespace=null] - Context this keyring accepts links for
   * @param {boolean} [opts.acceptLegacyV2=false] - Migration aid: also verify
   *   signatures over the pre-0.10 v2 payload (namespace-less links only).
   *   Off by default; turn it on only while re-signing persisted links.
   */
  constructor(opts = {}) {
    this.#storage = opts.storage || null;
    this.#namespace = opts.namespace ?? null;
    this.#acceptLegacyV2 = opts.acceptLegacyV2 === true;
  }

  /** The namespace this keyring accepts signed links and unlinks for. */
  get namespace() {
    return this.#namespace;
  }

  // -- Link management ----------------------------------------------------

  /**
   * Create an **unsigned, local-only** link from parent to child.
   *
   * Unsigned links are useful for local bookkeeping but carry no proof:
   * {@link MeshKeyring#verifyCryptoChain} refuses them unless called with
   * `requireSigned: false`. Use {@link SignedKeyLink.create} plus
   * {@link MeshKeyring#addVerifiedLink} for anything another party relies on.
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
      namespace: this.#namespace,
    });
    this.#links.push(link);
    return link;
  }

  /**
   * Remove a link between parent and child. **Local only**: nothing is
   * signed and peers are not told. To revoke a link in a way peers can
   * verify and relay, create a {@link SignedKeyUnlink} and
   * {@link MeshKeyring#applyUnlink} it.
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

  // -- Revocation ---------------------------------------------------------

  /**
   * Whether a recorded, unexpired {@link SignedKeyUnlink} revokes `link`.
   * An expired revocation no longer counts. If it expires before the link
   * does, the link is live again; give the unlink an `expires` at least as
   * late as the link's ({@link SignedKeyUnlink.forLink}). A link that is
   * itself expired stays unusable regardless (`verifyCryptoChain` checks it).
   *
   * @param {KeyLink} link
   * @param {number} [now=Date.now()]
   * @returns {boolean}
   */
  isRevoked(link, now = Date.now()) {
    return this.#revocations.some((r) => !r.isExpired(now) && r.revokes(link));
  }

  /**
   * Drop recorded revocations that have expired.
   *
   * @param {number} [now=Date.now()]
   * @returns {number} How many were dropped
   */
  pruneRevocations(now = Date.now()) {
    const before = this.#revocations.length;
    this.#revocations = this.#revocations.filter((r) => !r.isExpired(now));
    return before - this.#revocations.length;
  }

  /**
   * Apply a signed revocation: verify the parent's signature, record it
   * (so the revoked link cannot be re-added or verified later, even if it
   * arrives after the unlink), and remove the edge.
   *
   * Cascades: every descendant of the child loses the authority it derived
   * through the revoked edge — {@link MeshKeyring#verifyCryptoChain} from
   * any of them to an ancestor above the edge fails. The descendants are
   * returned so callers can react (re-enroll, notify).
   *
   * @param {SignedKeyUnlink} unlink
   * @param {CryptoKey} parentPub - The unlink's parent's Ed25519 public key
   * @returns {Promise<{ removed: boolean, descendants: string[] }>}
   */
  async applyUnlink(unlink, parentPub) {
    if (!(unlink instanceof SignedKeyUnlink)) {
      throw new Error('Expected a SignedKeyUnlink instance');
    }
    if (unlink.namespace !== this.#namespace) {
      throw new Error(
        `Namespace mismatch: unlink is for ${JSON.stringify(unlink.namespace)}, keyring is ${JSON.stringify(this.#namespace)}`
      );
    }
    let ok = false;
    try {
      ok = await unlink.verify(parentPub);
    } catch {
      ok = false;
    }
    if (!ok) throw new Error('Signature verification failed');

    // Already expired: it no longer counts, so record and relay nothing.
    if (unlink.isExpired()) return { removed: false, descendants: [] };

    const descendants = this.#descendantsOf(unlink.child);

    const same = (r) =>
      r.parent === unlink.parent && r.child === unlink.child && r.created === unlink.created;
    const idx = this.#revocations.findIndex(same);
    if (idx < 0) {
      this.#revocations.push(unlink);
    } else {
      // Same revocation, possibly with a different expiry: keep the longer-lived.
      const old = this.#revocations[idx];
      if (old.expires !== null && (unlink.expires === null || unlink.expires > old.expires)) {
        this.#revocations[idx] = unlink;
      }
    }

    const before = this.#links.length;
    this.#links = this.#links.filter((l) => !unlink.revokes(l));
    return { removed: this.#links.length < before, descendants };
  }

  /**
   * Recorded signed revocations that have not expired (copies of the list,
   * same objects); expired ones are dropped from the keyring first. Relay
   * these to peers so they can {@link MeshKeyring#applyUnlink} them.
   *
   * @param {{ now?: number }} [opts]
   * @returns {SignedKeyUnlink[]}
   */
  listRevocations(opts = {}) {
    this.pruneRevocations(opts.now ?? Date.now());
    return [...this.#revocations];
  }

  /** @param {string} id @returns {string[]} */
  #descendantsOf(id) {
    const out = [];
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift();
      for (const l of this.#links) {
        if (l.parent === cur && !seen.has(l.child)) {
          seen.add(l.child);
          out.push(l.child);
          queue.push(l.child);
        }
      }
    }
    return out;
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
   * Verify a chain for expiration (structure only, no signatures; see
   * {@link MeshKeyring#verifyCryptoChain}).
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
   * Add a signed link after verifying its signatures, its namespace and
   * that no recorded unlink revokes it.
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
    if (signedLink.namespace !== this.#namespace) {
      throw new Error(
        `Namespace mismatch: link is for ${JSON.stringify(signedLink.namespace)}, keyring is ${JSON.stringify(this.#namespace)}`
      );
    }
    if (this.isRevoked(signedLink)) {
      throw new Error(`Link has been revoked: ${signedLink.parent} -> ${signedLink.child}`);
    }

    const valid = await signedLink.verifyBoth(parentPub, childPub, {
      acceptLegacyV2: this.#acceptLegacyV2,
    });
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
   * Verify an entire chain cryptographically: every link on the path from
   * `fromId` up to `toId` must be signed by both ends, unexpired, in this
   * keyring's namespace, and not revoked by a recorded {@link SignedKeyUnlink}.
   *
   * On failure, `brokenAt` is the child ID of the offending link (or
   * `'no-path'`) and `reason` is one of `'no-path'`, `'expired'`,
   * `'revoked'`, `'namespace'`, `'unsigned'` or `'bad-signature'`.
   *
   * @param {string} fromId - Starting identity (leaf)
   * @param {string} toId - Target identity (root/ancestor)
   * @param {Function} getPublicKey - async (podId) => CryptoKey
   * @param {object} [opts]
   * @param {boolean} [opts.requireSigned=true] - Refuse unsigned KeyLinks.
   *   `false` restores the pre-0.10 behaviour of skipping them; only for
   *   purely local graphs.
   * @param {boolean} [opts.acceptLegacyV2] - Defaults to the keyring's setting
   * @param {number} [opts.now=Date.now()]
   * @returns {Promise<{valid: boolean, chain: KeyLink[], brokenAt?: string, reason?: string}>}
   */
  async verifyCryptoChain(fromId, toId, getPublicKey, opts = {}) {
    const requireSigned = opts.requireSigned ?? true;
    const acceptLegacyV2 = opts.acceptLegacyV2 ?? this.#acceptLegacyV2;
    const now = opts.now ?? Date.now();

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
      return { valid: false, chain: relevantChain, brokenAt: 'no-path', reason: 'no-path' };
    }

    const fail = (link, reason) => ({ valid: false, chain: relevantChain, brokenAt: link.child, reason });

    for (const link of relevantChain) {
      if (link.isExpired(now)) return fail(link, 'expired');
      if (this.isRevoked(link, now)) return fail(link, 'revoked');
      if ((link.namespace ?? null) !== this.#namespace) return fail(link, 'namespace');

      if (!(link instanceof SignedKeyLink)) {
        if (requireSigned) return fail(link, 'unsigned');
        continue;
      }

      try {
        const parentPub = await getPublicKey(link.parent);
        const childPub = await getPublicKey(link.child);
        const ok = await link.verifyBoth(parentPub, childPub, { acceptLegacyV2 });
        if (!ok) return fail(link, 'bad-signature');
      } catch {
        return fail(link, 'bad-signature');
      }
    }

    return { valid: true, chain: relevantChain };
  }

  // -- Succession / Dead Man's Switch -------------------------------------

  /**
   * Register a succession policy for a primary identity.
   *
   * The policy and the activity log are **local state**: nothing about them
   * is signed. They decide when this keyring acts, not what peers accept.
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
   * - **transfer**: moves every child of `primaryId` under `successorId`.
   *   The keyring cannot sign on anyone's behalf, so the caller supplies
   *   `opts.links`: one {@link SignedKeyLink} per child, signed by the
   *   successor (as parent) and the child, with the same relation and a
   *   scope/expiry no wider than the link it replaces, in this keyring's
   *   namespace. They are all verified (via `opts.getPublicKey`) before
   *   anything changes; if any is missing or invalid, the call rejects and
   *   the keyring is untouched. Pass `{ localOnly: true }` instead to get
   *   the pre-0.10 behaviour of re-linking with **unsigned** local links,
   *   which `verifyCryptoChain` refuses by default.
   * - **revoke**: removes all child links of primaryId (locally; to tell
   *   peers, distribute {@link SignedKeyUnlink}s signed by the primary).
   * - **notify**: returns a notification signal without modifying links.
   *
   * The policy is removed after successful execution.
   *
   * @param {string} primaryId
   * @param {object} [opts]
   * @param {SignedKeyLink[]} [opts.links] - Successor-signed replacement links (transfer)
   * @param {Function} [opts.getPublicKey] - async (podId) => CryptoKey (transfer)
   * @param {boolean} [opts.localOnly=false] - transfer with unsigned local links
   * @returns {Promise<{ action: string, primaryId: string, successorId: string, affected: number }>}
   */
  async executeSuccession(primaryId, opts = {}) {
    const policy = this.#successions.get(primaryId);
    if (!policy) {
      throw new Error(`No succession policy for: ${primaryId}`);
    }

    const children = this.getChildren(primaryId);
    let affected = 0;

    if (policy.action === 'transfer') {
      const successorId = policy.successorId;
      if (opts.localOnly === true) {
        for (const child of children) {
          this.unlink(primaryId, child.child);
          if (successorId !== child.child) {
            const existing = this.#links.find(
              (l) => l.parent === successorId && l.child === child.child
            );
            if (!existing) {
              this.link(successorId, child.child, child.relation, {
                scope: child.scope || undefined,
                expires: child.expires ?? undefined,
              });
            }
          }
          affected++;
        }
      } else {
        const supplied = opts.links || [];
        const plan = [];
        for (const child of children) {
          if (child.child === successorId) {
            plan.push({ child, replacement: null });
            continue;
          }
          const alreadyLinked = this.#links.some(
            (l) => l.parent === successorId && l.child === child.child
          );
          if (alreadyLinked) {
            plan.push({ child, replacement: null });
            continue;
          }
          const replacement = supplied.find(
            (l) => l && l.parent === successorId && l.child === child.child
          );
          if (!(replacement instanceof SignedKeyLink)) {
            throw new Error(
              `transfer needs a SignedKeyLink ${successorId} -> ${child.child} signed by both (or pass localOnly: true)`
            );
          }
          if (replacement.relation !== child.relation) {
            throw new Error(`Replacement link for ${child.child} changes relation`);
          }
          if (!scopeNarrows(child.scope, replacement.scope) ||
              !expiresNarrows(child.expires, replacement.expires)) {
            throw new Error(`Replacement link for ${child.child} is wider than the link it replaces`);
          }
          if (replacement.namespace !== this.#namespace) {
            throw new Error(`Replacement link for ${child.child} has the wrong namespace`);
          }
          if (this.isRevoked(replacement)) {
            throw new Error(`Replacement link for ${child.child} has been revoked`);
          }
          if (typeof opts.getPublicKey !== 'function') {
            throw new Error('transfer needs opts.getPublicKey to verify replacement links');
          }
          let ok = false;
          try {
            ok = await replacement.verifyBoth(
              await opts.getPublicKey(replacement.parent),
              await opts.getPublicKey(replacement.child),
              { acceptLegacyV2: this.#acceptLegacyV2 }
            );
          } catch {
            ok = false;
          }
          if (!ok) {
            throw new Error(`Replacement link for ${child.child}: signature verification failed`);
          }
          plan.push({ child, replacement });
        }

        // Every replacement verified: now mutate.
        for (const { child, replacement } of plan) {
          this.unlink(primaryId, child.child);
          if (replacement) this.#links.push(replacement);
          affected++;
        }
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
   * Serialize the keyring.
   *
   * Shape (since 0.10): `{ v: 3, namespace, links, revocations }`. Before
   * 0.10 this was a bare array of links; {@link MeshKeyring.fromJSON} still
   * reads that. An older browsermesh-core given the new object fails to
   * load it (it is not iterable) rather than misreading revocations as links.
   *
   * @returns {{ v: 3, namespace: string|null, links: object[], revocations: object[] }}
   */
  toJSON() {
    return {
      v: 3,
      namespace: this.#namespace,
      links: this.#links.map((l) => l.toJSON()),
      revocations: this.listRevocations().map((r) => r.toJSON()),
    };
  }

  /**
   * Deserialize a keyring.
   *
   * Accepts the current object form and the pre-0.10 bare array of links.
   * Signatures are not re-checked here (no keys are available); they are
   * checked by {@link MeshKeyring#verifyCryptoChain}. Recorded revocations
   * are restored as-is: a revocation can only remove authority, so trusting
   * the local copy fails closed.
   *
   * @param {object|object[]} data
   * @param {object} [opts] - Constructor options (`storage`, `namespace`,
   *   `acceptLegacyV2`). `namespace` defaults to the serialised one and
   *   must agree with it when both are given.
   * @returns {MeshKeyring}
   */
  static fromJSON(data, opts = {}) {
    const legacy = Array.isArray(data);
    const links = legacy ? data : (data?.links ?? []);
    const revocations = legacy ? [] : (data?.revocations ?? []);
    const storedNs = legacy ? null : (data?.namespace ?? null);
    if (!legacy && 'namespace' in opts && (opts.namespace ?? null) !== storedNs) {
      throw new Error('Namespace mismatch between options and serialised keyring');
    }
    const kr = new MeshKeyring({ ...opts, namespace: opts.namespace ?? storedNs });
    for (const d of links) {
      /*
       * Dispatch on the serialised shape. Reviving everything through
       * `KeyLink.fromJSON` returned a plain KeyLink for signed links too, so
       * a restored keyring verified without any cryptography (#33).
       */
      kr.#links.push(
        d && (d.parentSignature || d.childSignature || d.signed)
          ? SignedKeyLink.fromJSON(d)
          : KeyLink.fromJSON(d)
      );
    }
    for (const r of revocations) {
      const u = SignedKeyUnlink.fromJSON(r);
      if (!u.isExpired()) kr.#revocations.push(u);
    }
    return kr;
  }
}
