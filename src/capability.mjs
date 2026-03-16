/**
 * Parse a capability scope string into structured parts.
 *
 * Scope grammar: `<namespace>:<resource>:<action>`
 * Example: `"mesh:crdt:write"`, `"mesh:transport:*"`
 *
 * @param {string} scope - Scope string to parse
 * @returns {{ namespace: string, resource: string, action: string }}
 */
export function parseScope(scope) {
  const parts = scope.split(':');
  return {
    namespace: parts[0] || '*',
    resource: parts[1] || '*',
    action: parts[2] || '*',
  };
}

/**
 * Check whether a granted scope matches a required scope.
 * Supports wildcard (`*`) matching at any level.
 *
 * @param {string} granted - The scope that was granted
 * @param {string} required - The scope being checked against
 * @returns {boolean} True if granted covers required
 */
export function matchScope(granted, required) {
  const g = parseScope(granted);
  const r = parseScope(required);

  const matches = (grantedPart, requiredPart) =>
    grantedPart === '*' || grantedPart === requiredPart;

  return matches(g.namespace, r.namespace) &&
    matches(g.resource, r.resource) &&
    matches(g.action, r.action);
}

/**
 * Represents a capability token — a signed grant of specific permissions.
 *
 * @class
 */
export class CapabilityToken {
  /**
   * @param {object} opts
   * @param {string} opts.issuer - Pod ID of the issuer
   * @param {string} opts.subject - Pod ID of the grantee
   * @param {string[]} opts.scopes - Granted scope strings
   * @param {number} opts.expiresAt - Unix timestamp (seconds) of expiry
   * @param {Uint8Array} [opts.signature] - Ed25519 signature over the token
   */
  constructor({ issuer, subject, scopes, expiresAt, signature }) {
    /** @type {string} */
    this.issuer = issuer;
    /** @type {string} */
    this.subject = subject;
    /** @type {string[]} */
    this.scopes = scopes;
    /** @type {number} */
    this.expiresAt = expiresAt;
    /** @type {Uint8Array|undefined} */
    this.signature = signature;
  }

  /**
   * Check if the token has expired.
   *
   * @param {number} [now=Date.now()/1000] - Current time in seconds
   * @returns {boolean}
   */
  isExpired(now = Date.now() / 1000) {
    return this.expiresAt > 0 && now >= this.expiresAt;
  }

  /**
   * Check if this token's scopes cover a required scope.
   *
   * @param {string} scope - The scope to check
   * @returns {boolean}
   */
  covers(scope) {
    return this.scopes.some(s => matchScope(s, scope));
  }

  /**
   * Serialize the token to a plain JSON-compatible object.
   *
   * @returns {{ issuer: string, subject: string, scopes: string[], expiresAt: number }}
   */
  toJSON() {
    return {
      issuer: this.issuer,
      subject: this.subject,
      scopes: this.scopes,
      expiresAt: this.expiresAt,
    };
  }
}
