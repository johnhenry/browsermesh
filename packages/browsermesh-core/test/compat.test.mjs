// Run with: node --import ./test/_setup-globals.mjs --test test/compat.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { BrowserTool, BrowserToolRegistry } from '../src/compat.mjs';
import { IdentityListTool, IdentityCreateTool } from '../src/identity-tools.mjs';

describe('BrowserToolRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new BrowserToolRegistry();
  });

  it('registers a real BrowserTool subclass and returns it', () => {
    const tool = new IdentityListTool();
    const returned = registry.register(tool);
    assert.equal(returned, tool);
  });

  it('get() returns the registered tool instance', () => {
    const tool = new IdentityListTool();
    registry.register(tool);
    assert.equal(registry.get('identity_list'), tool);
  });

  it('get() returns undefined for an unknown name', () => {
    assert.equal(registry.get('does_not_exist'), undefined);
  });

  it('list() returns all registered tool instances', () => {
    const listTool = new IdentityListTool();
    const createTool = new IdentityCreateTool();
    registry.register(listTool);
    registry.register(createTool);
    const listed = registry.list();
    assert.equal(listed.length, 2);
    assert.ok(listed.includes(listTool));
    assert.ok(listed.includes(createTool));
  });

  it('listSpecs() returns the .spec of every registered tool, LLM-tool-calling shaped', () => {
    registry.register(new IdentityListTool());
    registry.register(new IdentityCreateTool());
    const specs = registry.listSpecs();
    assert.equal(specs.length, 2);
    const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
    assert.ok(byName.identity_list);
    assert.equal(byName.identity_list.description, new IdentityListTool().description);
    assert.deepEqual(byName.identity_list.parameters, { type: 'object', properties: {} });
    assert.equal(byName.identity_list.required_permission, 'read');
    assert.ok(byName.identity_create);
    assert.equal(byName.identity_create.required_permission, 'approve');
  });

  it('execute() on a registered tool still works through the registry', async () => {
    registry.register(new IdentityListTool());
    const result = await registry.get('identity_list').execute();
    assert.equal(result.success, true);
  });

  it('registering a duplicate tool name throws and does not replace the original', () => {
    const first = new IdentityListTool();
    const second = new IdentityListTool();
    registry.register(first);
    assert.throws(() => registry.register(second), /already registered/);
    assert.equal(registry.get('identity_list'), first);
    assert.equal(registry.list().length, 1);
  });

  it('unregister() removes a tool and returns true', () => {
    registry.register(new IdentityListTool());
    assert.equal(registry.unregister('identity_list'), true);
    assert.equal(registry.get('identity_list'), undefined);
    assert.equal(registry.list().length, 0);
  });

  it('unregister() returns false for a name that was never registered', () => {
    assert.equal(registry.unregister('nope'), false);
  });

  it('unregister() then re-register with the same name succeeds', () => {
    const first = new IdentityListTool();
    registry.register(first);
    registry.unregister('identity_list');
    const second = new IdentityListTool();
    assert.doesNotThrow(() => registry.register(second));
    assert.equal(registry.get('identity_list'), second);
  });

  it('rejects a plain object with no .spec/.execute with a clear error', () => {
    assert.throws(
      () => registry.register({ name: 'fake_tool' }),
      /BrowserTool shape/,
    );
  });

  it('rejects a tool missing execute()', () => {
    const notATool = { get spec() { return { name: 'x', description: 'd', parameters: {}, required_permission: 'read' }; } };
    assert.throws(() => registry.register(notATool), /BrowserTool shape/);
  });

  it('rejects an abstract BrowserTool instance whose getters still throw', () => {
    assert.throws(() => registry.register(new BrowserTool()), /BrowserTool shape/);
  });

  it('rejects null/undefined/primitives', () => {
    assert.throws(() => registry.register(null), /BrowserTool shape/);
    assert.throws(() => registry.register(undefined), /BrowserTool shape/);
    assert.throws(() => registry.register('not a tool'), /BrowserTool shape/);
  });

  it('accepts a duck-typed tool that is not an instanceof BrowserTool', () => {
    class ExternalTool {
      get spec() {
        return { name: 'external_tool', description: 'd', parameters: { type: 'object', properties: {} }, required_permission: 'read' };
      }
      get name() { return 'external_tool'; }
      async execute() { return { success: true, output: 'ok' }; }
    }
    const tool = new ExternalTool();
    assert.ok(!(tool instanceof BrowserTool));
    assert.doesNotThrow(() => registry.register(tool));
    assert.equal(registry.get('external_tool'), tool);
  });
});
