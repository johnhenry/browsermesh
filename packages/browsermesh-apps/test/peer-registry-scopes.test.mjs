// Run with: node --import ./test/_setup-globals.mjs --test test/peer-registry-scopes.test.mjs
//
// A grant in a namespace whose grammar is written down (`objects:ROOT[:OP]`, `mcp:TOOL`: wsh's capability
// notation, spec/capabilities.md) is checked when it is made. matchScope reads a missing or empty segment as `*`,
// so `objects:` (no root) would otherwise grant every root and `mcp:` every tool: the notation refuses both, and
// refuses an entry it does not understand rather than keeping the rest. Other namespaces are untouched.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PeerRegistry } from '../src/peer-registry.mjs';
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core';

const registry = () => new PeerRegistry({ localPodId: 'host', peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: 'host' }) });

describe('grantCapabilities refuses a malformed objects: or mcp: entry', () => {
  const refused = [
    'objects:', 'objects::get', 'objects', 'objects:window:', 'objects:window:fly', 'objects:window:get:x',
    'objects:win dow:get', 'objects:window:GET', 'objects:wi"ndow', 'objects:a,b:get', 'objects:a\nb',
    'mcp:', 'mcp', 'mcp:echo ', 'mcp:ec ho', 'mcp:a"b', 'mcp:a,b', 'mcp:a\nb',
  ];
  for (const scope of refused) {
    it(`refuses ${JSON.stringify(scope)} and grants nothing`, () => {
      const reg = registry();
      assert.throws(() => reg.grantCapabilities('peer', ['objects:ok:get', scope]), TypeError);
      assert.equal(reg.checkAccess('peer', 'objects:ok', 'get').allowed, false, 'a list with a malformed entry is not granted in part');
      assert.equal(reg.checkAccess('peer', 'objects:anything', 'get').allowed, false);
      assert.equal(reg.checkAccess('peer', 'mcp:anything', 'call').allowed, false);
    });
  }

  const accepted = [
    'objects:window', 'objects:window:get', 'objects:window:call', 'objects:window:set', 'objects:window:on',
    'objects:*', 'objects:*:get', 'objects:window:*', 'objects:$app:get', 'objects:docs.v2:get',
    'mcp:echo', 'mcp:*', 'mcp:echo:call', 'mcp:*:call', 'mcp:echo:list', 'mcp:*:list',
    // other namespaces are the registry's own, unchanged
    'files:read', 'protocol:objects:open', 'protocol:*:open', 'mesh-relay:chat:connect', 'a::b', '*',
  ];
  for (const scope of accepted) {
    it(`still grants ${JSON.stringify(scope)}`, () => {
      assert.doesNotThrow(() => registry().grantCapabilities('peer', [scope]));
    });
  }

  it('an empty root does not widen: objects:window:get covers window only', () => {
    const reg = registry();
    reg.grantCapabilities('peer', ['objects:window:get']);
    assert.equal(reg.checkAccess('peer', 'objects:window', 'get').allowed, true);
    assert.equal(reg.checkAccess('peer', 'objects:store', 'get').allowed, false);
  });

  it('a scope that is not a string is refused', () => {
    const reg = registry();
    for (const bad of [undefined, null, 7, {}, '']) assert.throws(() => reg.grantCapabilities('peer', [bad]), TypeError);
  });
});
