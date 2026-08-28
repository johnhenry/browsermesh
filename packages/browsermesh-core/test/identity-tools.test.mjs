// Run with: node --import ./test/_setup-globals.mjs --test test/identity-tools.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  IdentityToolsContext,
  identityToolsContext,
  IdentityCreateTool,
  IdentityListTool,
  IdentitySwitchTool,
  IdentityExportTool,
  IdentityImportTool,
  IdentityDeleteTool,
  IdentityLinkTool,
  IdentitySelectRuleTool,
  registerIdentityTools,
} from '../src/identity-tools.mjs';
import {
  MeshIdentityManager,
  InMemoryIdentityStorage,
  AutoIdentityManager,
  IdentitySelector,
} from '../src/identity.mjs';
import { MeshKeyring } from '../src/keyring.mjs';
import { BrowserTool } from '../src/compat.mjs';

// ---------------------------------------------------------------------------
// IdentityToolsContext
// ---------------------------------------------------------------------------

describe('IdentityToolsContext', () => {
  it('starts with null values', () => {
    const ctx = new IdentityToolsContext();
    assert.equal(ctx.getAutoIdMgr(), null);
    assert.equal(ctx.getKeyring(), null);
    assert.equal(ctx.getSelector(), null);
  });

  it('sets and gets auto identity manager', () => {
    const ctx = new IdentityToolsContext();
    ctx.setAutoIdMgr('mgr');
    assert.equal(ctx.getAutoIdMgr(), 'mgr');
  });

  it('sets and gets keyring', () => {
    const ctx = new IdentityToolsContext();
    ctx.setKeyring('kr');
    assert.equal(ctx.getKeyring(), 'kr');
  });

  it('sets and gets selector', () => {
    const ctx = new IdentityToolsContext();
    ctx.setSelector('sel');
    assert.equal(ctx.getSelector(), 'sel');
  });
});

// ---------------------------------------------------------------------------
// Tool tests
// ---------------------------------------------------------------------------

describe('Identity Tools', () => {
  let storage;
  let idMgr;
  let autoMgr;
  let keyring;
  let selector;

  beforeEach(async () => {
    storage = new InMemoryIdentityStorage();
    idMgr = new MeshIdentityManager({ storage });
    autoMgr = new AutoIdentityManager(idMgr, storage);
    await autoMgr.boot('ws-test');

    keyring = new MeshKeyring();
    selector = new IdentitySelector(autoMgr);

    identityToolsContext.setAutoIdMgr(autoMgr);
    identityToolsContext.setKeyring(keyring);
    identityToolsContext.setSelector(selector);
  });

  // -- IdentityCreateTool ------------------------------------------------

  describe('IdentityCreateTool', () => {
    const tool = new IdentityCreateTool();

    it('extends BrowserTool', () => {
      assert.ok(tool instanceof BrowserTool);
    });

    it('has correct name and permission', () => {
      assert.equal(tool.name, 'identity_create');
      assert.equal(tool.permission, 'approve');
    });

    it('creates an identity with label', async () => {
      const result = await tool.execute({ label: 'test-id' });
      assert.equal(result.success, true);
      assert.ok(result.output.includes('test-id'));
      assert.ok(result.output.includes('Pod ID'));
    });

    it('creates with default label when none provided', async () => {
      const result = await tool.execute({});
      assert.equal(result.success, true);
      assert.ok(result.output.includes('unnamed'));
    });

    it('fails when manager not initialized', async () => {
      identityToolsContext.setAutoIdMgr(null);
      const result = await tool.execute({ label: 'test' });
      assert.equal(result.success, false);
      assert.ok(result.error.includes('not initialized'));
    });
  });

  // -- IdentityListTool --------------------------------------------------

  describe('IdentityListTool', () => {
    const tool = new IdentityListTool();

    it('has correct name and permission', () => {
      assert.equal(tool.name, 'identity_list');
      assert.equal(tool.permission, 'read');
    });

    it('lists identities with active marker', async () => {
      await idMgr.create('alice');
      const result = await tool.execute();
      assert.equal(result.success, true);
      assert.ok(result.output.includes('ACTIVE'));
      assert.ok(result.output.includes('*'));
    });

    it('shows "No identities" when empty', async () => {
      identityToolsContext.setAutoIdMgr(null);
      const result = await tool.execute();
      assert.ok(result.output.includes('No identities'));
    });
  });

  // -- IdentitySwitchTool ------------------------------------------------

  describe('IdentitySwitchTool', () => {
    const tool = new IdentitySwitchTool();

    it('has correct name and permission', () => {
      assert.equal(tool.name, 'identity_switch');
      assert.equal(tool.permission, 'write');
    });

    it('switches active identity', async () => {
      const s = await idMgr.create('switchable');
      const result = await tool.execute({ podId: s.podId });
      assert.equal(result.success, true);
      assert.ok(result.output.includes('switchable'));
    });

    it('fails for unknown podId', async () => {
      const result = await tool.execute({ podId: 'nonexistent' });
      assert.equal(result.success, false);
      assert.ok(result.error.includes('Unknown identity'));
    });
  });

  // -- IdentityExportTool ------------------------------------------------

  describe('IdentityExportTool', () => {
    const tool = new IdentityExportTool();

    it('has correct name and permission', () => {
      assert.equal(tool.name, 'identity_export');
      assert.equal(tool.permission, 'approve');
    });

    it('exports identity as JWK', async () => {
      const active = autoMgr.getActive();
      const result = await tool.execute({ podId: active.podId });
      assert.equal(result.success, true);
      assert.ok(result.output.includes('OKP'));
    });

    it('fails for unknown podId', async () => {
      const result = await tool.execute({ podId: 'nope' });
      assert.equal(result.success, false);
    });
  });

  // -- IdentityImportTool ------------------------------------------------

  describe('IdentityImportTool', () => {
    const tool = new IdentityImportTool();

    it('has correct name and permission', () => {
      assert.equal(tool.name, 'identity_import');
      assert.equal(tool.permission, 'approve');
    });

    it('imports identity from JWK', async () => {
      // Export one first to get valid JWK
      const s = await idMgr.create('export-me');
      const jwk = await idMgr.export(s.podId);
      idMgr.delete(s.podId);

      const result = await tool.execute({ keyData: jwk, label: 're-imported' });
      assert.equal(result.success, true);
      assert.ok(result.output.includes('re-imported'));
    });
  });

  // -- IdentityDeleteTool ------------------------------------------------

  describe('IdentityDeleteTool', () => {
    const tool = new IdentityDeleteTool();

    it('has correct name and permission', () => {
      assert.equal(tool.name, 'identity_delete');
      assert.equal(tool.permission, 'approve');
    });

    it('deletes an identity', async () => {
      const s = await idMgr.create('to-delete');
      const result = await tool.execute({ podId: s.podId });
      assert.equal(result.success, true);
      assert.ok(result.output.includes('deleted'));
    });

    it('refuses to delete last identity', async () => {
      // autoMgr.boot created one. Only 1 identity exists.
      const active = autoMgr.getActive();
      const result = await tool.execute({ podId: active.podId });
      assert.equal(result.success, false);
      assert.ok(result.error.includes('last identity'));
    });

    it('fails for unknown identity', async () => {
      await idMgr.create('extra'); // ensure >1
      const result = await tool.execute({ podId: 'nonexistent' });
      assert.equal(result.success, false);
      assert.ok(result.error.includes('not found'));
    });
  });

  // -- IdentityLinkTool --------------------------------------------------

  describe('IdentityLinkTool', () => {
    const tool = new IdentityLinkTool();

    it('has correct name and permission', () => {
      assert.equal(tool.name, 'identity_link');
      assert.equal(tool.permission, 'approve');
    });

    it('creates a signed link between two identities', async () => {
      const s1 = await idMgr.create('parent-id');
      const s2 = await idMgr.create('child-id');

      const result = await tool.execute({
        parentPodId: s1.podId,
        childPodId: s2.podId,
        relation: 'device',
      });
      assert.equal(result.success, true);
      assert.ok(result.output.includes('device'));
      assert.equal(keyring.size, 1);
    });

    it('fails if identity not found locally', async () => {
      const s1 = await idMgr.create('parent-only');
      const result = await tool.execute({
        parentPodId: s1.podId,
        childPodId: 'unknown-child',
        relation: 'device',
      });
      assert.equal(result.success, false);
      assert.ok(result.error.includes('must exist locally'));
    });

    it('fails when manager not initialized', async () => {
      identityToolsContext.setAutoIdMgr(null);
      const result = await tool.execute({
        parentPodId: 'p',
        childPodId: 'c',
        relation: 'device',
      });
      assert.equal(result.success, false);
    });
  });

  // -- IdentitySelectRuleTool --------------------------------------------

  describe('IdentitySelectRuleTool', () => {
    const tool = new IdentitySelectRuleTool();

    it('has correct name and permission', () => {
      assert.equal(tool.name, 'identity_select_rule');
      assert.equal(tool.permission, 'write');
    });

    it('sets a peer selection rule', async () => {
      const active = autoMgr.getActive();
      const result = await tool.execute({ peerId: 'peer1', podId: active.podId });
      assert.equal(result.success, true);
      assert.ok(result.output.includes('Rule set'));

      const rules = selector.listRules();
      assert.equal(rules.length, 1);
      assert.equal(rules[0].peerId, 'peer1');
    });

    it('fails when selector not initialized', async () => {
      identityToolsContext.setSelector(null);
      const result = await tool.execute({ peerId: 'peer1', podId: 'pod1' });
      assert.equal(result.success, false);
      assert.ok(result.error.includes('not initialized'));
    });
  });
});

// ---------------------------------------------------------------------------
// registerIdentityTools
// ---------------------------------------------------------------------------

describe('registerIdentityTools', () => {
  it('registers all 8 tools', async () => {
    const registered = new Map();
    const registry = {
      register(tool) { registered.set(tool.name, tool); },
    };

    const storage = new InMemoryIdentityStorage();
    const idMgr = new MeshIdentityManager({ storage });
    const autoMgr = new AutoIdentityManager(idMgr, storage);
    await autoMgr.boot('ws-test');
    const keyring = new MeshKeyring();
    const selector = new IdentitySelector(autoMgr);

    registerIdentityTools(registry, autoMgr, keyring, selector);

    assert.equal(registered.size, 8);
    assert.ok(registered.has('identity_create'));
    assert.ok(registered.has('identity_list'));
    assert.ok(registered.has('identity_switch'));
    assert.ok(registered.has('identity_export'));
    assert.ok(registered.has('identity_import'));
    assert.ok(registered.has('identity_delete'));
    assert.ok(registered.has('identity_link'));
    assert.ok(registered.has('identity_select_rule'));
  });
});
