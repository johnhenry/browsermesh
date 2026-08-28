/**
 * clawser-mesh-identity-tools.js -- Identity BrowserTools for mesh.
 *
 * 8 BrowserTool subclasses for managing mesh identities via the agent.
 * Follows the pattern in clawser-mesh-tools.js.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-identity-tools.test.mjs
 */

import { BrowserTool } from './compat.mjs';

// ── Shared state ─────────────────────────────────────────────────────

/**
 * Holds references to identity subsystem instances
 * so tools can access them without import cycles.
 */
export class IdentityToolsContext {
  #autoIdMgr = null;
  #keyring = null;
  #selector = null;

  setAutoIdMgr(mgr) { this.#autoIdMgr = mgr; }
  getAutoIdMgr() { return this.#autoIdMgr; }

  setKeyring(kr) { this.#keyring = kr; }
  getKeyring() { return this.#keyring; }

  setSelector(sel) { this.#selector = sel; }
  getSelector() { return this.#selector; }
}

/** Singleton context for identity tools. */
export const identityToolsContext = new IdentityToolsContext();

// ── identity_create ─────────────────────────────────────────────────

export class IdentityCreateTool extends BrowserTool {
  get name() { return 'identity_create'; }
  get description() {
    return 'Create a new Ed25519 mesh identity with an optional label.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Human-readable name for the identity' },
      },
    };
  }
  get permission() { return 'approve'; }

  async execute({ label } = {}) {
    try {
      const mgr = identityToolsContext.getAutoIdMgr();
      if (!mgr) {
        return { success: false, output: '', error: 'Identity manager not initialized.' };
      }

      const idMgr = mgr.identityManager;
      const summary = await idMgr.create(label || 'unnamed');
      await idMgr.save();

      return {
        success: true,
        output: `Identity created:\n  Pod ID: ${summary.podId}\n  Label: ${summary.label}\n  DID: ${summary.did}`,
      };
    } catch (err) {
      return { success: false, output: '', error: `Create failed: ${err.message}` };
    }
  }
}

// ── identity_list ───────────────────────────────────────────────────

export class IdentityListTool extends BrowserTool {
  get name() { return 'identity_list'; }
  get description() {
    return 'List all mesh identities with their pod IDs, labels, and active status.';
  }
  get parameters() {
    return { type: 'object', properties: {} };
  }
  get permission() { return 'read'; }

  async execute() {
    try {
      const mgr = identityToolsContext.getAutoIdMgr();
      if (!mgr) {
        return { success: true, output: 'No identities (identity manager not initialized).' };
      }

      const identities = mgr.listIdentities();
      if (identities.length === 0) {
        return { success: true, output: 'No identities.' };
      }

      const lines = identities.map(id =>
        `${id.isActive ? '* ' : '  '}${id.podId.slice(0, 12)}... | ${id.label}`
      );
      return {
        success: true,
        output: `ACTIVE | POD ID | LABEL\n${lines.join('\n')}`,
      };
    } catch (err) {
      return { success: false, output: '', error: err.message };
    }
  }
}

// ── identity_switch ─────────────────────────────────────────────────

export class IdentitySwitchTool extends BrowserTool {
  get name() { return 'identity_switch'; }
  get description() {
    return 'Switch the active mesh identity to a different pod ID.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        podId: { type: 'string', description: 'Pod ID of the identity to activate' },
      },
      required: ['podId'],
    };
  }
  get permission() { return 'write'; }

  async execute({ podId }) {
    try {
      const mgr = identityToolsContext.getAutoIdMgr();
      if (!mgr) {
        return { success: false, output: '', error: 'Identity manager not initialized.' };
      }

      await mgr.switchIdentity(podId);
      const active = mgr.getActive();
      return {
        success: true,
        output: `Switched to identity: ${active.label} (${active.podId.slice(0, 12)}...)`,
      };
    } catch (err) {
      return { success: false, output: '', error: `Switch failed: ${err.message}` };
    }
  }
}

// ── identity_export ─────────────────────────────────────────────────

export class IdentityExportTool extends BrowserTool {
  get name() { return 'identity_export'; }
  get description() {
    return 'Export an identity as a JWK (optionally encrypted with a passphrase).';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        podId: { type: 'string', description: 'Pod ID to export' },
        passphrase: { type: 'string', description: 'Optional passphrase for encryption' },
      },
      required: ['podId'],
    };
  }
  get permission() { return 'approve'; }

  async execute({ podId, passphrase }) {
    try {
      const mgr = identityToolsContext.getAutoIdMgr();
      if (!mgr) {
        return { success: false, output: '', error: 'Identity manager not initialized.' };
      }

      const jwk = await mgr.identityManager.export(podId, passphrase);
      const encrypted = jwk.encrypted ? ' (encrypted)' : '';
      return {
        success: true,
        output: `Identity exported${encrypted}:\n${JSON.stringify(jwk, null, 2)}`,
      };
    } catch (err) {
      return { success: false, output: '', error: `Export failed: ${err.message}` };
    }
  }
}

// ── identity_import ─────────────────────────────────────────────────

export class IdentityImportTool extends BrowserTool {
  get name() { return 'identity_import'; }
  get description() {
    return 'Import an identity from a JWK private key.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        keyData: { type: 'object', description: 'JWK private key object' },
        label: { type: 'string', description: 'Human-readable label' },
      },
      required: ['keyData'],
    };
  }
  get permission() { return 'approve'; }

  async execute({ keyData, label }) {
    try {
      const mgr = identityToolsContext.getAutoIdMgr();
      if (!mgr) {
        return { success: false, output: '', error: 'Identity manager not initialized.' };
      }

      const summary = await mgr.identityManager.import(keyData, label || 'imported');
      await mgr.identityManager.save();
      return {
        success: true,
        output: `Identity imported:\n  Pod ID: ${summary.podId}\n  Label: ${summary.label}\n  DID: ${summary.did}`,
      };
    } catch (err) {
      return { success: false, output: '', error: `Import failed: ${err.message}` };
    }
  }
}

// ── identity_delete ─────────────────────────────────────────────────

export class IdentityDeleteTool extends BrowserTool {
  get name() { return 'identity_delete'; }
  get description() {
    return 'Delete a mesh identity by pod ID. Cannot delete the last remaining identity.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        podId: { type: 'string', description: 'Pod ID to delete' },
      },
      required: ['podId'],
    };
  }
  get permission() { return 'approve'; }

  async execute({ podId }) {
    try {
      const mgr = identityToolsContext.getAutoIdMgr();
      if (!mgr) {
        return { success: false, output: '', error: 'Identity manager not initialized.' };
      }

      const idMgr = mgr.identityManager;
      if (idMgr.size <= 1) {
        return { success: false, output: '', error: 'Cannot delete the last identity.' };
      }

      const existed = idMgr.delete(podId);
      if (!existed) {
        return { success: false, output: '', error: `Identity ${podId} not found.` };
      }

      await idMgr.save();
      return { success: true, output: `Identity ${podId.slice(0, 12)}... deleted.` };
    } catch (err) {
      return { success: false, output: '', error: `Delete failed: ${err.message}` };
    }
  }
}

// ── identity_link ───────────────────────────────────────────────────

export class IdentityLinkTool extends BrowserTool {
  get name() { return 'identity_link'; }
  get description() {
    return 'Create a signed link between two identities (parent endorses child).';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        parentPodId: { type: 'string', description: 'Parent identity pod ID' },
        childPodId: { type: 'string', description: 'Child identity pod ID' },
        relation: { type: 'string', description: 'Relation type: device, delegate, org, alias, recovery' },
      },
      required: ['parentPodId', 'childPodId', 'relation'],
    };
  }
  get permission() { return 'approve'; }

  async execute({ parentPodId, childPodId, relation }) {
    try {
      const mgr = identityToolsContext.getAutoIdMgr();
      const kr = identityToolsContext.getKeyring();
      if (!mgr || !kr) {
        return { success: false, output: '', error: 'Identity manager or keyring not initialized.' };
      }

      const idMgr = mgr.identityManager;
      const parentIdentity = idMgr.getIdentity(parentPodId);
      const childIdentity = idMgr.getIdentity(childPodId);

      if (!parentIdentity || !childIdentity) {
        return { success: false, output: '', error: 'Both identities must exist locally to create a signed link.' };
      }

      // Import SignedKeyLink dynamically to avoid circular dep
      const { SignedKeyLink } = await import('./keyring.mjs');
      const signedLink = await SignedKeyLink.create(parentIdentity, childIdentity, relation);

      await kr.addVerifiedLink(
        signedLink,
        parentIdentity.keyPair.publicKey,
        childIdentity.keyPair.publicKey
      );

      return {
        success: true,
        output: `Signed link created: ${parentPodId.slice(0, 12)}... -[${relation}]-> ${childPodId.slice(0, 12)}...`,
      };
    } catch (err) {
      return { success: false, output: '', error: `Link failed: ${err.message}` };
    }
  }
}

// ── identity_select_rule ────────────────────────────────────────────

export class IdentitySelectRuleTool extends BrowserTool {
  get name() { return 'identity_select_rule'; }
  get description() {
    return 'Set a rule to use a specific identity when connecting to a peer.';
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        peerId: { type: 'string', description: 'Peer ID to set the rule for' },
        podId: { type: 'string', description: 'Pod ID of the identity to use' },
      },
      required: ['peerId', 'podId'],
    };
  }
  get permission() { return 'write'; }

  async execute({ peerId, podId }) {
    try {
      const sel = identityToolsContext.getSelector();
      if (!sel) {
        return { success: false, output: '', error: 'Identity selector not initialized.' };
      }

      sel.setRule(peerId, podId);
      return {
        success: true,
        output: `Rule set: use identity ${podId.slice(0, 12)}... for peer ${peerId.slice(0, 12)}...`,
      };
    } catch (err) {
      return { success: false, output: '', error: `Rule failed: ${err.message}` };
    }
  }
}

// ── Registry helper ──────────────────────────────────────────────────

/**
 * Register all identity tools with a BrowserToolRegistry.
 * @param {import('./compat.mjs').BrowserToolRegistry} registry
 * @param {import('./identity.mjs').AutoIdentityManager} [autoIdMgr]
 * @param {import('./keyring.mjs').MeshKeyring} [keyring]
 * @param {import('./identity.mjs').IdentitySelector} [selector]
 */
export function registerIdentityTools(registry, autoIdMgr, keyring, selector) {
  if (autoIdMgr) identityToolsContext.setAutoIdMgr(autoIdMgr);
  if (keyring) identityToolsContext.setKeyring(keyring);
  if (selector) identityToolsContext.setSelector(selector);

  registry.register(new IdentityCreateTool());
  registry.register(new IdentityListTool());
  registry.register(new IdentitySwitchTool());
  registry.register(new IdentityExportTool());
  registry.register(new IdentityImportTool());
  registry.register(new IdentityDeleteTool());
  registry.register(new IdentityLinkTool());
  registry.register(new IdentitySelectRuleTool());
}
