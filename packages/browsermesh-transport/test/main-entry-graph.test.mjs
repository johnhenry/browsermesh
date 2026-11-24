// Run with: node --import ./test/_setup-globals.mjs --test test/main-entry-graph.test.mjs
//
// The main entry has to be bundlable for a browser with `@johnhenry/wsh` absent: a bundler (or a "no bare
// specifiers" check on a vendored copy) must find no wsh specifier and no Node-only module anywhere in the
// graph it can reach from `src/index.mjs`. wsh features live behind `./wsh`; the in-process test relay is
// Node-only. This pins that by scanning the import graph the way a bundler reads it (static imports, re-exports
// and literal `import()` calls), because no bundler is installed in this repository.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const pkgDir = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

/** Every specifier a bundler would see in `text`: import/export-from, bare `import 'x'`, and `import('x')` / `import(expr)`. */
export function specifiersOf(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found = [];
  for (const m of code.matchAll(/\b(?:import|export)\s+(?:[^'";()]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) found.push({ spec: m[1], dynamic: false });
  for (const m of code.matchAll(/(?<![.\w$])import\(\s*([^)]*?)\s*\)/g)) {
    const lit = /^['"]([^'"]+)['"]$/.exec(m[1]);
    found.push({ spec: lit ? lit[1] : null, dynamic: true, expr: m[1] });
  }
  return found;
}

/** Walk the relative-import graph from an entry file; return { files, bare, nonLiteral }. */
export function graphOf(entry) {
  const files = new Set();
  const bare = new Set();
  const nonLiteral = [];
  const visit = (file) => {
    if (files.has(file)) return;
    files.add(file);
    for (const { spec, expr } of specifiersOf(readFileSync(file, 'utf8'))) {
      if (spec === null) { nonLiteral.push(`${file}: import(${expr})`); continue; }
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
      else bare.add(spec);
    }
  };
  visit(entry);
  return { files: [...files].map((f) => f.slice(pkgDir.length)), bare: [...bare], nonLiteral };
}

const NODE_ONLY = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

describe('the main entry is browser-bundlable with wsh absent', () => {
  const entry = join(pkgDir, 'src/index.mjs');
  const graph = graphOf(entry);

  it('the scanner sees the graph (it is not vacuous)', () => {
    assert.ok(graph.files.length >= 10, `only ${graph.files.length} files reached`);
    assert.ok(graph.files.includes('src/transport.mjs'));
    assert.ok(graph.bare.includes('@johnhenry/browsermesh-primitives'));
    // and it does see a wsh specifier where one exists
    const links = graphOf(join(pkgDir, 'src/wsh-links.mjs'));
    assert.ok(links.bare.some((s) => s.startsWith('@johnhenry/wsh')), 'the scanner must find the lazy wsh import in wsh-links.mjs');
  });

  it('no module in the main entry graph names @johnhenry/wsh (static or literal import())', () => {
    assert.deepEqual(graph.bare.filter((s) => s.startsWith('@johnhenry/wsh')), []);
    for (const f of graph.files) assert.ok(!/^src\/wsh-(links|services|relay|pod-transport|in-process)\.mjs$/.test(f), `${f} is reachable from the main entry`);
  });

  it('no module in the main entry graph imports a Node-only module', () => {
    assert.deepEqual(graph.bare.filter((s) => NODE_ONLY.has(s)), []);
  });

  it('the only bare specifier the main entry needs is the primitives peer', () => {
    assert.deepEqual(graph.bare, ['@johnhenry/browsermesh-primitives']);
  });

  it('no import() with a computed specifier hides a dependency from a bundler', () => {
    assert.deepEqual(graph.nonLiteral, []);
  });

  it('the wsh modules are reachable from ./wsh and name wsh there', () => {
    const wsh = graphOf(join(pkgDir, 'src/wsh.mjs'));
    for (const f of ['src/wsh-links.mjs', 'src/wsh-services.mjs', 'src/wsh-relay.mjs', 'src/wsh-pod-transport.mjs']) assert.ok(wsh.files.includes(f), f);
    assert.ok(wsh.bare.includes('@johnhenry/wsh'));
  });
});

describe('the exports map', () => {
  it('"." resolves to the browser-safe entry for everything except the node condition', () => {
    const dot = pkg.exports['.'];
    assert.equal(dot.default, './src/index.mjs');
    assert.equal(pkg.main, './src/index.mjs');
    assert.notEqual(dot.node, './src/index.mjs');
  });

  it('the node condition keeps the pre-0.11 names for one release, and only there', async () => {
    const compat = graphOf(join(pkgDir, pkg.exports['.'].node));
    assert.ok(compat.files.includes('src/wsh-links.mjs'));
    const names = ['WshPeerLinks', 'WshLink', 'WshLinkError', 'createWshTransportFactory', 'rendezvousId', 'initiatorWins', 'resolveCredential',
      'LINK_USERNAME_PREFIX', 'usernameForPodId', 'WshServices', 'connectWshServicesOverMesh', 'WSH_SERVICES_GRANTS', 'wshObjectActionFor',
      'servicesRendezvousId', 'WshRelay', 'WSH_RELAY_PROTOCOL', 'connectWshServicesViaRelay', 'WshPodTransport'];
    const viaName = await import('@johnhenry/browsermesh-transport'); // node condition
    const clean = await import('../src/index.mjs');
    const sub = await import('@johnhenry/browsermesh-transport/wsh');
    for (const n of names) {
      assert.notEqual(typeof viaName[n], 'undefined', `${n} missing from the node entry`);
      assert.equal(viaName[n], sub[n], `${n} differs between the node entry and ./wsh`);
      assert.equal(n in clean, false, `${n} leaked into the browser-safe entry`);
    }
    // what stays on the main entry for everyone
    for (const n of ['TransportFactory', 'MeshWshBridge', 'FrameDecoder', 'encodeFrame', 'WshFrameError', 'podIdToFingerprint', 'fingerprintToPodId', 'podIdFromRawKey']) {
      assert.notEqual(typeof clean[n], 'undefined', `${n} must stay on the main entry`);
    }
  });

  it('./wsh-in-process is Node-only: it resolves under the node condition and under nothing else', () => {
    assert.deepEqual(pkg.exports['./wsh-in-process'], { node: './src/wsh-in-process.mjs' });
  });

  it('./wsh is a plain subpath', () => {
    assert.equal(pkg.exports['./wsh'], './src/wsh.mjs');
  });

  it('the optional wsh peer does not constrain a consumer that pins another wsh', () => {
    assert.equal(pkg.peerDependencies['@johnhenry/wsh'], '*');
    assert.equal(pkg.peerDependenciesMeta['@johnhenry/wsh'].optional, true);
  });
});
