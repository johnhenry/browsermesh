/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-acl.js -- Remote access control for BrowserMesh.
 *
 * ScopeTemplate bundles, roster management, invitation tokens, and
 * access checking. Wraps mesh-primitives ACLEngine with higher-level
 * identity-centric management.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-acl.test.mjs
 */

import {
  ACLEngine,
  AccessGrant,
  Permission,
  generateGrantId,
  matchScope,
} from '@johnhenry/browsermesh-primitives';

// ---------------------------------------------------------------------------
// ScopeTemplate
// ---------------------------------------------------------------------------

/**
 * Named capability bundle — maps a friendly name to a set of scope strings.
 */
export class ScopeTemplate {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {string[]} opts.scopes
   * @param {string} [opts.description]
   */
  constructor({ name, scopes, description }) {
    this.name = name;
    this.scopes = [...scopes];
    this.description = description;
  }

  /**
   * Check if this template covers a given scope.
   * Uses matchScope from mesh-primitives for wildcard support.
   * @param {string} scope
   * @returns {boolean}
   */
  matches(scope) {
    return this.scopes.some(s => matchScope(s, scope));
  }

  toJSON() {
    return {
      name: this.name,
      scopes: [...this.scopes],
      description: this.description,
    };
  }

  static fromJSON(data) {
    return new ScopeTemplate({
      name: data.name,
      scopes: data.scopes,
      description: data.description,
    });
  }
}

// ---------------------------------------------------------------------------
// DEFAULT_TEMPLATES
// ---------------------------------------------------------------------------

export const DEFAULT_TEMPLATES = Object.freeze({
  guest: new ScopeTemplate({
    name: 'guest',
    scopes: ['chat:read', 'files:read'],
    description: 'Read-only access to chat and files',
  }),
  collaborator: new ScopeTemplate({
    name: 'collaborator',
    scopes: ['chat:*', 'files:read', 'files:write', 'compute:submit'],
    description: 'Full chat, file read/write, and compute submission',
  }),
  admin: new ScopeTemplate({
    name: 'admin',
    scopes: ['*:*'],
    description: 'Full access to all resources',
  }),
});

// ---------------------------------------------------------------------------
// RosterEntry
// ---------------------------------------------------------------------------

/**
 * An identity in the access roster.
 */
export class RosterEntry {
  /**
   * @param {object} opts
   * @param {string} opts.identity - Fingerprint of the identity
   * @param {string} opts.templateName - Name of the assigned template
   * @param {string[]} [opts.scopes] - Additional scope overrides
   * @param {object} [opts.quotas] - Usage quotas
   * @param {string} [opts.label] - Human-friendly label
   * @param {number} [opts.expires] - Expiration timestamp (ms)
   * @param {number} [opts.created] - Creation timestamp (ms)
   */
  constructor({ identity, templateName, scopes, quotas, label, expires, created }) {
    this.identity = identity;
    this.templateName = templateName;
    this.scopes = scopes ? [...scopes] : undefined;
    this.quotas = quotas ? { ...quotas } : undefined;
    this.label = label;
    this.expires = expires;
    this.created = created ?? Date.now();
  }

  /**
   * @param {number} [now]
   * @returns {boolean}
   */
  isExpired(now = Date.now()) {
    if (this.expires == null) return false;
    return now >= this.expires;
  }

  toJSON() {
    return {
      identity: this.identity,
      templateName: this.templateName,
      scopes: this.scopes ? [...this.scopes] : undefined,
      quotas: this.quotas ? { ...this.quotas } : undefined,
      label: this.label,
      expires: this.expires,
      created: this.created,
    };
  }

  static fromJSON(data) {
    return new RosterEntry({
      identity: data.identity,
      templateName: data.templateName,
      scopes: data.scopes,
      quotas: data.quotas,
      label: data.label,
      expires: data.expires,
      created: data.created,
    });
  }
}

// ---------------------------------------------------------------------------
// InvitationToken
// ---------------------------------------------------------------------------

/** @type {number} */
let _nonceSeq = 0;

/**
 * Single-use invitation token.
 */
export class InvitationToken {
  /**
   * @param {object} opts
   * @param {string} opts.owner - Fingerprint of the inviter
   * @param {string} opts.templateName - Template to grant on redemption
   * @param {number} [opts.expires] - Expiration timestamp (ms), default 15 min from now
   * @param {string} [opts.nonce] - Unique nonce, auto-generated if omitted
   */
  constructor({ owner, templateName, expires, nonce }) {
    this.owner = owner;
    this.templateName = templateName;
    this.expires = expires ?? (Date.now() + 15 * 60 * 1000);
    this.nonce = nonce ?? `inv_${Date.now().toString(36)}_${(++_nonceSeq).toString(36)}`;
    /** @type {boolean} */
    this._used = false;
  }

  /** @param {number} [now] */
  isExpired(now = Date.now()) {
    return now >= this.expires;
  }

  isUsed() {
    return this._used;
  }

  markUsed() {
    this._used = true;
  }

  toJSON() {
    return {
      owner: this.owner,
      templateName: this.templateName,
      expires: this.expires,
      nonce: this.nonce,
      used: this._used,
    };
  }

  static fromJSON(data) {
    const tok = new InvitationToken({
      owner: data.owner,
      templateName: data.templateName,
      expires: data.expires,
      nonce: data.nonce,
    });
    tok._used = data.used ?? false;
    return tok;
  }
}

// ---------------------------------------------------------------------------
// MeshACL
// ---------------------------------------------------------------------------

/**
 * Top-level remote access control manager.
 *
 * Combines templates (scope bundles), a roster (identity→template mapping),
 * an internal ACLEngine for access checks, and invitation tokens.
 */
export class MeshACL {
  /**
   * @param {object} opts
   * @param {string} opts.owner - Fingerprint of the workspace owner
   * @param {function} [opts.onLog]
   */
  constructor({ owner, onLog }) {
    this.owner = owner;
    this._onLog = onLog || (() => {});

    /** @type {Map<string, ScopeTemplate>} */
    this._templates = new Map();
    /** @type {Map<string, RosterEntry>} */
    this._roster = new Map();
    /** @type {ACLEngine} */
    this._engine = new ACLEngine();
    /** @type {Map<string, InvitationToken>} */
    this._invitations = new Map();

    // Seed default templates
    for (const [name, tpl] of Object.entries(DEFAULT_TEMPLATES)) {
      this._templates.set(name, tpl);
    }
  }

  // ── Template management ────────────────────────────────────────────

  /**
   * @param {string} name
   * @param {string[]} scopes
   * @param {string} [description]
   * @returns {ScopeTemplate}
   */
  addTemplate(name, scopes, description) {
    const t = new ScopeTemplate({ name, scopes, description });
    this._templates.set(name, t);
    return t;
  }

  /** @param {string} name @returns {boolean} */
  removeTemplate(name) {
    return this._templates.delete(name);
  }

  /** @param {string} name @returns {ScopeTemplate|null} */
  getTemplate(name) {
    return this._templates.get(name) ?? null;
  }

  /** @returns {ScopeTemplate[]} */
  listTemplates() {
    return [...this._templates.values()];
  }

  // ── Roster management ──────────────────────────────────────────────

  /**
   * @param {string} identity
   * @param {string} templateName
   * @param {object} [opts]
   * @returns {RosterEntry}
   */
  addEntry(identity, templateName, opts = {}) {
    const tpl = this._templates.get(templateName);
    if (!tpl) throw new Error(`Unknown template: ${templateName}`);

    const entry = new RosterEntry({
      identity,
      templateName,
      label: opts.label,
      quotas: opts.quotas,
      expires: opts.expires,
    });
    this._roster.set(identity, entry);

    // Create internal ACLEngine grant
    this._syncGrant(identity, tpl, entry);

    return entry;
  }

  /** @param {string} identity @returns {boolean} */
  removeEntry(identity) {
    const had = this._roster.delete(identity);
    if (had) {
      this._engine.revokeAll(identity);
    }
    return had;
  }

  /** @param {string} identity @returns {RosterEntry|null} */
  getEntry(identity) {
    return this._roster.get(identity) ?? null;
  }

  /** @returns {RosterEntry[]} */
  listEntries() {
    return [...this._roster.values()];
  }

  // ── Access checking ────────────────────────────────────────────────

  /**
   * Check if an identity is allowed to perform an action on a resource.
   * Owner is always allowed.
   *
   * @param {string} identity
   * @param {string} resource
   * @param {string} action
   * @returns {{ allowed: boolean, reason?: string }}
   */
  check(identity, resource, action) {
    // Owner bypass
    if (identity === this.owner) {
      return { allowed: true, reason: 'owner' };
    }

    // Check roster entry expiry
    const entry = this._roster.get(identity);
    if (!entry) {
      return { allowed: false, reason: 'not_in_roster' };
    }
    if (entry.isExpired()) {
      return { allowed: false, reason: 'entry_expired' };
    }

    // Check via template scope matching
    const tpl = this._templates.get(entry.templateName);
    if (!tpl) {
      return { allowed: false, reason: 'template_missing' };
    }

    // Build the scope string as resource:action
    const scope = `${resource}:${action}`;
    if (tpl.matches(scope)) {
      return { allowed: true };
    }

    return { allowed: false, reason: 'scope_denied' };
  }

  // ── Invitation flow ────────────────────────────────────────────────

  /**
   * @param {string} templateName
   * @param {object} [opts]
   * @param {number} [opts.expires]
   * @returns {InvitationToken}
   */
  createInvitation(templateName, opts = {}) {
    if (!this._templates.has(templateName)) {
      throw new Error(`Unknown template: ${templateName}`);
    }
    const tok = new InvitationToken({
      owner: this.owner,
      templateName,
      expires: opts.expires,
    });
    this._invitations.set(tok.nonce, tok);
    return tok;
  }

  /**
   * Redeem an invitation, creating a roster entry.
   * @param {InvitationToken} token
   * @param {string} identity
   * @returns {RosterEntry}
   */
  redeemInvitation(token, identity) {
    if (token.isExpired()) {
      throw new Error('Invitation expired');
    }
    if (token.isUsed()) {
      throw new Error('Invitation already used');
    }
    token.markUsed();
    return this.addEntry(identity, token.templateName);
  }

  // ── Revocation ─────────────────────────────────────────────────────

  /**
   * Update an existing roster entry with a new template.
   * @param {string} identity
   * @param {string} templateName
   * @returns {RosterEntry|null}
   */
  updateEntry(identity, templateName) {
    if (!this._roster.has(identity)) return null;
    this._engine.revokeAll(identity);
    this._roster.delete(identity);
    return this.addEntry(identity, templateName);
  }

  /** Convenience alias for {@link addEntry}. */
  grant(identity, templateName, opts) { return this.addEntry(identity, templateName, opts) }

  /** Convenience alias for {@link revokeAll}. */
  revoke(identity) { return this.revokeAll(identity) }

  /**
   * Revoke all access for an identity and remove from roster.
   * @param {string} identity
   * @returns {number}
   */
  revokeAll(identity) {
    const had = this._roster.has(identity);
    this._roster.delete(identity);
    const count = this._engine.revokeAll(identity);
    return had ? Math.max(count, 1) : 0;
  }

  // ── Maintenance ────────────────────────────────────────────────────

  /**
   * Remove expired roster entries.
   * @param {number} [now]
   * @returns {number}
   */
  pruneExpired(now = Date.now()) {
    let count = 0;
    for (const [id, entry] of this._roster) {
      if (entry.isExpired(now)) {
        this._roster.delete(id);
        this._engine.revokeAll(id);
        count++;
      }
    }
    return count;
  }

  // ── Serialization ──────────────────────────────────────────────────

  toJSON() {
    return {
      owner: this.owner,
      templates: [...this._templates.values()]
        .filter(t => !DEFAULT_TEMPLATES[t.name]) // only custom templates
        .map(t => t.toJSON()),
      roster: [...this._roster.values()].map(e => e.toJSON()),
      invitations: [...this._invitations.values()].map(t => t.toJSON()),
    };
  }

  static fromJSON(data) {
    const acl = new MeshACL({ owner: data.owner });

    // Restore custom templates
    if (data.templates) {
      for (const td of data.templates) {
        const t = ScopeTemplate.fromJSON(td);
        acl._templates.set(t.name, t);
      }
    }

    // Restore roster entries (with engine grants)
    if (data.roster) {
      for (const rd of data.roster) {
        const entry = RosterEntry.fromJSON(rd);
        acl._roster.set(entry.identity, entry);
        const tpl = acl._templates.get(entry.templateName);
        if (tpl) {
          acl._syncGrant(entry.identity, tpl, entry);
        }
      }
    }

    // Restore invitations
    if (data.invitations) {
      for (const td of data.invitations) {
        const tok = InvitationToken.fromJSON(td);
        acl._invitations.set(tok.nonce, tok);
      }
    }

    return acl;
  }

  // ── Internal helpers ───────────────────────────────────────────────

  /**
   * Sync an ACLEngine grant for an identity based on its template.
   * @param {string} identity
   * @param {ScopeTemplate} tpl
   * @param {RosterEntry} entry
   */
  _syncGrant(identity, tpl, entry) {
    const permissions = tpl.scopes.map(scope => {
      const parts = scope.split(':');
      const resource = parts[0] === '*' ? '*' : parts[0];
      const action = parts[1] === '*' ? '*' : (parts[1] || '*');
      return new Permission({ resource, actions: [action] });
    });

    const grant = new AccessGrant({
      id: generateGrantId(),
      grantee: identity,
      grantor: this.owner,
      permissions,
      conditions: entry.expires ? { expires: entry.expires } : {},
    });

    this._engine.addGrant(grant);
  }
}
