// Run with: node --import ./test/_setup-globals.mjs --test test/capability-vectors.test.mjs
//
// wsh's capability notation (spec/capabilities.md, with spec/capabilities.vectors.json) says what a list of
// capabilities such as `objects:window:get` or `mcp:search` permits. browsermesh's registry has its own scopes
// (`PeerRegistry.grantCapabilities` / `checkAccess`, `MeshACL`, `matchScope`), and for the forms the two share the
// strings coincide. This runs wsh's vectors, for the shared forms only, against the registry, so that "they agree"
// is a test and the places where they do not are written down.
//
// The vectors come from the installed `@johnhenry/wsh` (`@johnhenry/wsh/spec/capabilities.vectors.json`: the file ships
// with the package from 0.49.0) or from the file named by WSH_CAPABILITY_VECTORS. Where neither exists this skips and
// says so; REQUIRE_WSH_VECTORS makes that a failure, and this package's `npm test` sets it, so a skip is a failure in CI.
//
// Shared forms and how they map (docs/wsh-and-browsermesh.md has the table):
//   objects:ROOT[:OP]   the same string is a mesh scope; a request is checkAccess(peer, 'objects:ROOT', OP)
//   mcp:TOOL            the same string; running a tool is checkAccess(peer, 'mcp:TOOL', 'call'), listing it 'list'
//   rpc:NAME            is the mesh scope protocol:NAME:open; a request is checkAccess(peer, 'protocol:NAME', 'open')
// Not shared (the vectors for them are not run): exec, pty, fs:*, gateway:*, unix:*, endpoint:*, target:*, relay, and
// the wsh-only rules that a list with rpc:wsh-objects alone means every root, and that any objects: entry opens the channel.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PeerRegistry } from '../src/peer-registry.mjs';
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core';
import { fakeClock } from './helpers/fake-clock.mjs';

function locateVectors() {
  if (process.env.WSH_CAPABILITY_VECTORS) return process.env.WSH_CAPABILITY_VECTORS;
  try {
    const candidate = fileURLToPath(import.meta.resolve('@johnhenry/wsh/spec/capabilities.vectors.json'));
    if (existsSync(candidate)) return candidate;
  } catch { /* wsh not installed, or an older one that does not ship the vectors */ }
  return null;
}

const file = locateVectors();
const skip = file ? false : 'wsh\'s capability vectors are not available (the installed @johnhenry/wsh does not ship spec/capabilities.vectors.json; set WSH_CAPABILITY_VECTORS to a copy)';
if (!file && process.env.REQUIRE_WSH_VECTORS) throw new Error(`REQUIRE_WSH_VECTORS is set but ${skip}`);
const vectors = file ? JSON.parse(readFileSync(file, 'utf8')) : { version: 0, lists: [], requests: [] };

const SHARED = /^(objects|mcp|rpc):/;
const PEER = 'peer';

const meshScope = (capability) => (capability.startsWith('rpc:') ? `protocol:${capability.slice(4)}:open` : capability);

function registry(clock) {
  return new PeerRegistry({
    localPodId: 'host', peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: 'host' }), ...(clock ? { clock } : {}),
  });
}

/** What the registry says of a request, for a list granted to one peer; `{ refused }` when the grant itself is refused. */
function ask({ capabilities, request, expires, now }) {
  const clock = fakeClock(now === undefined ? 1_700_000_000_000 : now * 1000);
  const reg = registry(clock);
  try {
    reg.grantCapabilities(PEER, capabilities.map(meshScope), expires ? { expiresAt: Date.parse(expires) } : {});
  } catch (error) { return { refused: error.message }; }
  const [resource, action] = request.kind === 'objects' ? [`objects:${request.root}`, request.op]
    // listing a tool and running one are asked apart (wsh >= 0.49 says which, and browsermesh-mcp scopes them apart: `mcp:TOOL:list`, `mcp:TOOL:call`)
    : request.kind === 'mcp-call' ? [`mcp:${request.tool}`, 'call']
      : request.kind === 'mcp-tool' ? [`mcp:${request.tool}`, 'list']
        : [`protocol:${request.protocol}`, 'open'];
  return { permitted: reg.checkAccess(PEER, resource, action).allowed === true };
}

const sharedList = (capabilities) => capabilities.length > 0 && capabilities.every((c) => SHARED.test(c));
const sharedRequest = (r) => (r.request.kind === 'objects' || r.request.kind === 'mcp-call' || r.request.kind === 'mcp-tool'
  || (r.request.kind === 'open' && r.request.channel === 'rpc' && !r.request.scoped && !['wsh-fs', 'mcp', 'wsh-objects'].includes(r.request.protocol)))
  && sharedList(r.capabilities)
  && !r.capabilities.includes('rpc:wsh-objects') // wsh-only: rpc:wsh-objects alone means every root
  && !r.invalidList
  && (r.hosts ?? ['node']).includes('node');

/**
 * Where the registry and the notation disagree, and which side is right by the written grammar. A vector listed here
 * is expected to disagree (the test fails if it stops, so the entry cannot go stale); a disagreement not listed fails.
 * Each entry: the vector's name, what each says, who is right and what was done.
 */
const KNOWN = new Map([
  ['objects: that operation allows walking toward something', {
    wsh: 'objects:window:get permits `walk` (reading on the way to something else), and so does every other objects: entry for that root',
    registry: 'has no `walk` action: checkAccess(peer, "objects:window", "walk") is false for objects:window:get',
    verdict: 'no change. `walk` is wsh\'s rule for reading intermediate properties inside its own allow-lists, not an operation a request names; the layer asks the registry only about the terminal operation (browsermesh-objects), and a peer is told of a root if it holds any action on it, which is the same rule. A mesh scope that names `walk` is not a thing.',
  }],
  ['rpc: has no wildcard form', {
    wsh: '`rpc:*` is not a capability (an rpc protocol is opened by name only)',
    registry: '`protocol:*:open` is a documented wildcard of the registry (every protocol that is served, each of which authorises again inside)',
    verdict: 'by design, not changed: the registry\'s wildcard is its own. It has no wsh spelling and must never be translated to `rpc:*`; the mapping table says so.',
  }],
  ['objects: a path is not a root', {
    wsh: 'a root is `*` or 1 to 64 characters of letters, digits, `_`, `$`, `-`, starting with a letter, `_` or `$`: `window.document` is not a root',
    registry: 'a root of a mesh scope may contain `.` (createRootAuthorizer\'s own grammar), so `objects:window.document:get` is a grant of a root named `window.document`',
    verdict: 'not changed: a name with a dot is the registry\'s own to give a root. A root that is also reached through a wsh key must be in the intersection (the wsh grammar); the adapter hands wsh the same names, and wsh refuses a root it cannot name.',
  }],
]);

describe('wsh capability vectors, run against PeerRegistry for the forms the two notations share', { skip }, () => {
  it('uses a notation version this harness was written for', () => {
    assert.equal(vectors.version, 1)
  });

  const disagreements = [];
  const requests = vectors.requests.filter(sharedRequest);
  const lists = vectors.lists.filter((l) => sharedList(l.capabilities) && (l.hosts ?? ['node']).includes('node'));

  it('runs a meaningful number of vectors (a renamed field must not turn this into nothing)', () => {
    assert.ok(requests.length >= 25, `requests: ${requests.length}`);
    assert.ok(lists.length >= 6, `lists: ${lists.length}`);
  });

  for (const vector of requests) {
    it(`request: ${vector.name}`, () => {
      const got = ask(vector);
      const agrees = got.permitted === vector.permitted;
      if (!agrees) disagreements.push({ name: vector.name, wsh: vector.permitted, mesh: got });
      if (KNOWN.has(vector.name)) assert.ok(!agrees, `${vector.name}: listed as a known disagreement but the two now agree: remove it from KNOWN`);
      else assert.ok(agrees, `${vector.name}: the notation says permitted=${vector.permitted}, the registry says ${JSON.stringify(got)}`);
    });
  }

  for (const vector of lists) {
    it(`list: ${vector.name}`, () => {
      const got = ask({ capabilities: vector.capabilities, request: { kind: 'objects', root: 'x', op: 'get' } });
      const meshRefuses = got.refused !== undefined;
      const agrees = meshRefuses === (vector.result === 'refused');
      if (KNOWN.has(vector.name)) assert.ok(!agrees, `${vector.name}: listed as a known disagreement but the two now agree: remove it from KNOWN`);
      else assert.ok(agrees, `${vector.name}: the notation says ${vector.result}, the registry ${meshRefuses ? 'refuses' : 'accepts'} the grant`);
    });
  }

  it('every known disagreement names a vector that exists', () => {
    const names = new Set([...vectors.requests, ...vectors.lists].map((v) => v.name));
    for (const name of KNOWN.keys()) assert.ok(names.has(name), `${name} is not a vector`);
  });
});
