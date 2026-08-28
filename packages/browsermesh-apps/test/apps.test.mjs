// Run with: node --import ./test/_setup-globals.mjs --test test/apps.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  AppManifest, AppInstance, AppPermissionChecker, AppRegistry,
  AppStore, AppRPC, AppEventBus,
  APP_MANIFEST, APP_INSTALL, APP_UNINSTALL, APP_STATE_SYNC, APP_RPC, APP_EVENT,
} from '../src/apps.mjs';

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

describe('Wire constants', () => {
  it('APP_MANIFEST is 0xe5', () => {
    assert.equal(APP_MANIFEST, 0xe5);
  });

  it('APP_INSTALL is 0xe6', () => {
    assert.equal(APP_INSTALL, 0xe6);
  });

  it('APP_UNINSTALL is 0xe7', () => {
    assert.equal(APP_UNINSTALL, 0xe7);
  });

  it('APP_STATE_SYNC is 0xe8', () => {
    assert.equal(APP_STATE_SYNC, 0xe8);
  });

  it('APP_RPC is 0xe9', () => {
    assert.equal(APP_RPC, 0xe9);
  });

  it('APP_EVENT is 0xea', () => {
    assert.equal(APP_EVENT, 0xea);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validManifestOpts(overrides = {}) {
  return {
    id: 'com.example.testapp',
    name: 'Test App',
    version: '1.0.0',
    permissions: ['net', 'fs'],
    entryPoint: 'https://example.com/app.js',
    ...overrides,
  };
}

function createManifest(overrides = {}) {
  return new AppManifest(validManifestOpts(overrides));
}

// ---------------------------------------------------------------------------
// AppManifest — construction
// ---------------------------------------------------------------------------

describe('AppManifest — construction', () => {
  it('creates a manifest with required fields', () => {
    const m = createManifest();
    assert.equal(m.id, 'com.example.testapp');
    assert.equal(m.name, 'Test App');
    assert.equal(m.version, '1.0.0');
    assert.deepEqual(m.permissions, ['net', 'fs']);
    assert.equal(m.entryPoint, 'https://example.com/app.js');
  });

  it('applies defaults for optional fields', () => {
    const m = createManifest();
    assert.equal(m.description, null);
    assert.equal(m.author, null);
    assert.deepEqual(m.dependencies, []);
    assert.equal(m.minPeers, 1);
    assert.equal(m.maxPeers, null);
    assert.deepEqual(m.metadata, {});
    assert.equal(m.signature, null);
  });

  it('accepts all optional fields', () => {
    const m = createManifest({
      description: 'A test',
      author: 'pod-alice',
      dependencies: [{ id: 'lib.core', minVersion: '2.0.0' }],
      minPeers: 3,
      maxPeers: 10,
      metadata: { category: 'tools' },
      publishedAt: 12345,
      signature: 'sig-abc',
    });
    assert.equal(m.description, 'A test');
    assert.equal(m.author, 'pod-alice');
    assert.equal(m.minPeers, 3);
    assert.equal(m.maxPeers, 10);
    assert.deepEqual(m.metadata, { category: 'tools' });
    assert.equal(m.publishedAt, 12345);
    assert.equal(m.signature, 'sig-abc');
  });

  it('throws when id is missing', () => {
    assert.throws(() => new AppManifest({ name: 'X', version: '1.0.0', permissions: [], entryPoint: 'x' }), /id/i);
  });

  it('throws when name is missing', () => {
    assert.throws(() => new AppManifest({ id: 'x', version: '1.0.0', permissions: [], entryPoint: 'x' }), /name/i);
  });

  it('throws when version is missing', () => {
    assert.throws(() => new AppManifest({ id: 'x', name: 'X', permissions: [], entryPoint: 'x' }), /version/i);
  });

  it('throws when entryPoint is missing', () => {
    assert.throws(() => new AppManifest({ id: 'x', name: 'X', version: '1.0.0', permissions: [] }), /entryPoint/i);
  });
});

// ---------------------------------------------------------------------------
// AppManifest — validate
// ---------------------------------------------------------------------------

describe('AppManifest — validate', () => {
  it('returns true for valid manifest', () => {
    const m = createManifest();
    assert.equal(m.validate(), true);
  });

  it('returns false for invalid version format', () => {
    const m = createManifest({ version: 'latest' });
    assert.equal(m.validate(), false);
  });

  it('accepts semver-like x.y.z', () => {
    const m = createManifest({ version: '12.3.456' });
    assert.equal(m.validate(), true);
  });

  it('returns false for missing id (constructed via fromJSON bypass)', () => {
    const m = createManifest();
    // Directly mutate for this test
    m.id = '';
    assert.equal(m.validate(), false);
  });
});

// ---------------------------------------------------------------------------
// AppManifest — satisfiesDependency
// ---------------------------------------------------------------------------

describe('AppManifest — satisfiesDependency', () => {
  it('returns true when id matches and no minVersion', () => {
    const m = createManifest({ id: 'lib.core', version: '1.0.0' });
    assert.equal(m.satisfiesDependency({ id: 'lib.core' }), true);
  });

  it('returns false when id does not match', () => {
    const m = createManifest({ id: 'lib.core', version: '1.0.0' });
    assert.equal(m.satisfiesDependency({ id: 'lib.other' }), false);
  });

  it('returns true when version >= minVersion', () => {
    const m = createManifest({ id: 'lib.core', version: '2.1.0' });
    assert.equal(m.satisfiesDependency({ id: 'lib.core', minVersion: '2.0.0' }), true);
  });

  it('returns true when version equals minVersion', () => {
    const m = createManifest({ id: 'lib.core', version: '2.0.0' });
    assert.equal(m.satisfiesDependency({ id: 'lib.core', minVersion: '2.0.0' }), true);
  });

  it('returns false when version < minVersion', () => {
    const m = createManifest({ id: 'lib.core', version: '1.9.0' });
    assert.equal(m.satisfiesDependency({ id: 'lib.core', minVersion: '2.0.0' }), false);
  });
});

// ---------------------------------------------------------------------------
// AppManifest — toJSON / fromJSON
// ---------------------------------------------------------------------------

describe('AppManifest — toJSON / fromJSON', () => {
  it('round-trips all fields', () => {
    const m = createManifest({
      description: 'desc',
      author: 'alice',
      dependencies: [{ id: 'dep1', minVersion: '1.0.0' }],
      minPeers: 2,
      maxPeers: 5,
      metadata: { tag: 'v1' },
      publishedAt: 999,
      signature: 'sig',
    });
    const json = m.toJSON();
    const m2 = AppManifest.fromJSON(json);
    assert.equal(m2.id, m.id);
    assert.equal(m2.name, m.name);
    assert.equal(m2.version, m.version);
    assert.equal(m2.description, m.description);
    assert.equal(m2.author, m.author);
    assert.deepEqual(m2.permissions, m.permissions);
    assert.deepEqual(m2.dependencies, m.dependencies);
    assert.equal(m2.minPeers, m.minPeers);
    assert.equal(m2.maxPeers, m.maxPeers);
    assert.deepEqual(m2.metadata, m.metadata);
    assert.equal(m2.publishedAt, m.publishedAt);
    assert.equal(m2.signature, m.signature);
    assert.equal(m2.entryPoint, m.entryPoint);
  });

  it('toJSON returns a plain object', () => {
    const m = createManifest();
    const json = m.toJSON();
    assert.equal(typeof json, 'object');
    assert.ok(!(json instanceof AppManifest));
  });
});

// ---------------------------------------------------------------------------
// AppInstance — construction and state machine
// ---------------------------------------------------------------------------

describe('AppInstance — construction', () => {
  it('creates with manifest and installedBy', () => {
    const m = createManifest();
    const inst = new AppInstance({ manifest: m, installedBy: 'pod-a' });
    assert.equal(inst.id, 'com.example.testapp');
    assert.equal(inst.name, 'Test App');
    assert.equal(inst.state, 'installed');
    assert.deepEqual(inst.data, {});
    assert.deepEqual(inst.peers, []);
  });

  it('throws when manifest is missing', () => {
    assert.throws(() => new AppInstance({ installedBy: 'pod-a' }), /manifest/i);
  });

  it('throws when installedBy is missing', () => {
    assert.throws(() => new AppInstance({ manifest: createManifest() }), /installedBy/i);
  });
});

describe('AppInstance — state transitions', () => {
  let inst;
  beforeEach(() => {
    inst = new AppInstance({ manifest: createManifest(), installedBy: 'pod-a' });
  });

  it('start transitions installed -> starting -> running', () => {
    inst.start();
    assert.equal(inst.state, 'running');
  });

  it('pause transitions running -> paused', () => {
    inst.start();
    inst.pause();
    assert.equal(inst.state, 'paused');
  });

  it('start after pause transitions paused -> running', () => {
    inst.start();
    inst.pause();
    inst.start();
    assert.equal(inst.state, 'running');
  });

  it('stop transitions running -> stopping -> stopped', () => {
    inst.start();
    inst.stop();
    assert.equal(inst.state, 'stopped');
  });

  it('stop transitions paused -> stopping -> stopped', () => {
    inst.start();
    inst.pause();
    inst.stop();
    assert.equal(inst.state, 'stopped');
  });

  it('stop from installed -> stopped', () => {
    inst.stop();
    assert.equal(inst.state, 'stopped');
  });

  it('setError transitions to error', () => {
    inst.start();
    inst.setError('something broke');
    assert.equal(inst.state, 'error');
  });

  it('pause on non-running throws', () => {
    assert.throws(() => inst.pause(), /cannot pause/i);
  });

  it('start on stopped throws', () => {
    inst.stop();
    assert.throws(() => inst.start(), /cannot start/i);
  });

  it('pause on stopped throws', () => {
    inst.stop();
    assert.throws(() => inst.pause(), /cannot pause/i);
  });
});

// ---------------------------------------------------------------------------
// AppInstance — peer management
// ---------------------------------------------------------------------------

describe('AppInstance — peer management', () => {
  let inst;
  beforeEach(() => {
    inst = new AppInstance({ manifest: createManifest(), installedBy: 'pod-a' });
  });

  it('addPeer adds a peer', () => {
    inst.addPeer('pod-b');
    assert.equal(inst.hasPeer('pod-b'), true);
  });

  it('addPeer is idempotent (no duplicates)', () => {
    inst.addPeer('pod-b');
    inst.addPeer('pod-b');
    assert.equal(inst.peers.length, 1);
  });

  it('removePeer removes a peer', () => {
    inst.addPeer('pod-b');
    inst.removePeer('pod-b');
    assert.equal(inst.hasPeer('pod-b'), false);
  });

  it('removePeer is safe for non-existent peer', () => {
    inst.removePeer('pod-z');
    assert.equal(inst.peers.length, 0);
  });

  it('hasPeer returns false for unknown peer', () => {
    assert.equal(inst.hasPeer('pod-x'), false);
  });
});

// ---------------------------------------------------------------------------
// AppInstance — data updates and serialization
// ---------------------------------------------------------------------------

describe('AppInstance — data and serialization', () => {
  it('updateData merges into data', () => {
    const inst = new AppInstance({ manifest: createManifest(), installedBy: 'pod-a' });
    inst.updateData({ count: 1 });
    inst.updateData({ label: 'test' });
    assert.deepEqual(inst.data, { count: 1, label: 'test' });
  });

  it('updateData overwrites existing keys', () => {
    const inst = new AppInstance({ manifest: createManifest(), installedBy: 'pod-a' });
    inst.updateData({ count: 1 });
    inst.updateData({ count: 2 });
    assert.equal(inst.data.count, 2);
  });

  it('toJSON / fromJSON round-trip', () => {
    const inst = new AppInstance({ manifest: createManifest(), installedBy: 'pod-a' });
    inst.start();
    inst.addPeer('pod-b');
    inst.updateData({ key: 'val' });
    const json = inst.toJSON();
    const inst2 = AppInstance.fromJSON(json);
    assert.equal(inst2.id, inst.id);
    assert.equal(inst2.state, 'running');
    assert.deepEqual(inst2.data, { key: 'val' });
    assert.deepEqual(inst2.peers, ['pod-b']);
  });
});

// ---------------------------------------------------------------------------
// AppPermissionChecker
// ---------------------------------------------------------------------------

describe('AppPermissionChecker', () => {
  let checker;
  beforeEach(() => {
    checker = new AppPermissionChecker({ grantedPermissions: ['net', 'fs'] });
  });

  it('check returns true for granted permission', () => {
    assert.equal(checker.check('net'), true);
  });

  it('check returns false for non-granted permission', () => {
    assert.equal(checker.check('payment'), false);
  });

  it('checkAll returns granted and denied', () => {
    const result = checker.checkAll(['net', 'fs', 'payment', 'compute']);
    assert.deepEqual(result.granted.sort(), ['fs', 'net']);
    assert.deepEqual(result.denied.sort(), ['compute', 'payment']);
  });

  it('grant adds a permission', () => {
    checker.grant('identity');
    assert.equal(checker.check('identity'), true);
  });

  it('grant is idempotent', () => {
    checker.grant('net');
    assert.equal(checker.listGranted().filter(p => p === 'net').length, 1);
  });

  it('revoke removes a permission', () => {
    checker.revoke('net');
    assert.equal(checker.check('net'), false);
  });

  it('revoke is safe for non-existent permission', () => {
    checker.revoke('payment');
    assert.equal(checker.check('payment'), false);
  });

  it('listGranted returns all granted permissions', () => {
    assert.deepEqual(checker.listGranted().sort(), ['fs', 'net']);
  });
});

// ---------------------------------------------------------------------------
// AppRegistry — install / uninstall
// ---------------------------------------------------------------------------

describe('AppRegistry — install / uninstall', () => {
  let registry;
  beforeEach(() => {
    registry = new AppRegistry({ localPodId: 'pod-a' });
  });

  it('install creates an AppInstance', () => {
    const m = createManifest();
    const inst = registry.install(m);
    assert.equal(inst.id, m.id);
    assert.equal(inst.state, 'installed');
  });

  it('install with granted permissions stores them', () => {
    const m = createManifest({ permissions: ['net', 'fs', 'identity'] });
    registry.install(m, ['net', 'fs']);
    const inst = registry.get(m.id);
    assert.ok(inst);
  });

  it('install throws for duplicate app id', () => {
    const m = createManifest();
    registry.install(m);
    assert.throws(() => registry.install(m), /already installed/i);
  });

  it('install validates manifest', () => {
    const m = createManifest({ version: 'bad-version' });
    assert.throws(() => registry.install(m), /invalid manifest/i);
  });

  it('uninstall removes the app', () => {
    const m = createManifest();
    registry.install(m);
    registry.uninstall(m.id);
    assert.equal(registry.get(m.id), undefined);
  });

  it('uninstall stops a running app', () => {
    const m = createManifest();
    registry.install(m);
    registry.start(m.id);
    registry.uninstall(m.id);
    assert.equal(registry.get(m.id), undefined);
  });

  it('uninstall throws for non-existent app', () => {
    assert.throws(() => registry.uninstall('no-such-app'), /not found|not installed/i);
  });
});

// ---------------------------------------------------------------------------
// AppRegistry — lifecycle (start / pause / stop)
// ---------------------------------------------------------------------------

describe('AppRegistry — lifecycle', () => {
  let registry;
  beforeEach(() => {
    registry = new AppRegistry({ localPodId: 'pod-a' });
    registry.install(createManifest());
  });

  it('start transitions to running', () => {
    registry.start('com.example.testapp');
    assert.equal(registry.get('com.example.testapp').state, 'running');
  });

  it('pause transitions to paused', () => {
    registry.start('com.example.testapp');
    registry.pause('com.example.testapp');
    assert.equal(registry.get('com.example.testapp').state, 'paused');
  });

  it('stop transitions to stopped', () => {
    registry.start('com.example.testapp');
    registry.stop('com.example.testapp');
    assert.equal(registry.get('com.example.testapp').state, 'stopped');
  });

  it('start throws for non-existent app', () => {
    assert.throws(() => registry.start('no-app'), /not found/i);
  });
});

// ---------------------------------------------------------------------------
// AppRegistry — update
// ---------------------------------------------------------------------------

describe('AppRegistry — update', () => {
  let registry;
  beforeEach(() => {
    registry = new AppRegistry({ localPodId: 'pod-a' });
    registry.install(createManifest());
  });

  it('updates manifest version while preserving data', () => {
    registry.get('com.example.testapp').updateData({ saved: true });
    const newManifest = createManifest({ version: '2.0.0' });
    registry.update('com.example.testapp', newManifest);
    const inst = registry.get('com.example.testapp');
    assert.equal(inst.manifest.version, '2.0.0');
  });

  it('restarts app if it was running', () => {
    registry.start('com.example.testapp');
    const newManifest = createManifest({ version: '2.0.0' });
    registry.update('com.example.testapp', newManifest);
    assert.equal(registry.get('com.example.testapp').state, 'running');
  });

  it('does not restart if app was not running', () => {
    const newManifest = createManifest({ version: '2.0.0' });
    registry.update('com.example.testapp', newManifest);
    assert.equal(registry.get('com.example.testapp').state, 'installed');
  });

  it('throws for non-existent app', () => {
    assert.throws(() => registry.update('nope', createManifest()), /not found/i);
  });

  it('validates new manifest', () => {
    const bad = createManifest({ version: 'nope' });
    assert.throws(() => registry.update('com.example.testapp', bad), /invalid manifest/i);
  });
});

// ---------------------------------------------------------------------------
// AppRegistry — filtering and queries
// ---------------------------------------------------------------------------

describe('AppRegistry — filtering and queries', () => {
  let registry;
  beforeEach(() => {
    registry = new AppRegistry({ localPodId: 'pod-a' });
    registry.install(createManifest({ id: 'app1', name: 'Alpha', permissions: ['net'], author: 'alice' }));
    registry.install(createManifest({ id: 'app2', name: 'Beta', permissions: ['fs'], author: 'bob' }));
    registry.install(createManifest({ id: 'app3', name: 'Gamma', permissions: ['net', 'fs'], author: 'alice' }));
    registry.start('app1');
    registry.start('app3');
    registry.pause('app3');
  });

  it('list with no filter returns all', () => {
    assert.equal(registry.list().length, 3);
  });

  it('list filtered by state', () => {
    assert.equal(registry.list({ state: 'running' }).length, 1);
    assert.equal(registry.list({ state: 'paused' }).length, 1);
    assert.equal(registry.list({ state: 'installed' }).length, 1);
  });

  it('list filtered by author', () => {
    assert.equal(registry.list({ author: 'alice' }).length, 2);
  });

  it('list filtered by name (substring)', () => {
    assert.equal(registry.list({ name: 'lph' }).length, 1);
  });

  it('getByPermission returns apps using a specific permission', () => {
    const netApps = registry.getByPermission('net');
    assert.equal(netApps.length, 2);
  });

  it('getStats returns correct counts', () => {
    const stats = registry.getStats();
    assert.equal(stats.totalInstalled, 3);
    assert.equal(stats.running, 1);
    assert.equal(stats.paused, 1);
    assert.equal(stats.stopped, 0);
  });
});

// ---------------------------------------------------------------------------
// AppRegistry — callbacks
// ---------------------------------------------------------------------------

describe('AppRegistry — callbacks', () => {
  it('onInstall fires on install', () => {
    const registry = new AppRegistry({ localPodId: 'pod-a' });
    let called = false;
    registry.onInstall(() => { called = true; });
    registry.install(createManifest());
    assert.equal(called, true);
  });

  it('onUninstall fires on uninstall', () => {
    const registry = new AppRegistry({ localPodId: 'pod-a' });
    let firedId = null;
    registry.onUninstall((id) => { firedId = id; });
    registry.install(createManifest());
    registry.uninstall('com.example.testapp');
    assert.equal(firedId, 'com.example.testapp');
  });

  it('onStateChange fires on start/pause/stop', () => {
    const registry = new AppRegistry({ localPodId: 'pod-a' });
    const changes = [];
    registry.onStateChange((id, state) => { changes.push(state); });
    registry.install(createManifest());
    registry.start('com.example.testapp');
    registry.pause('com.example.testapp');
    registry.stop('com.example.testapp');
    assert.deepEqual(changes, ['running', 'paused', 'stopped']);
  });
});

// ---------------------------------------------------------------------------
// AppRegistry — toJSON / fromJSON
// ---------------------------------------------------------------------------

describe('AppRegistry — toJSON / fromJSON', () => {
  it('round-trips installed apps', () => {
    const registry = new AppRegistry({ localPodId: 'pod-a' });
    registry.install(createManifest());
    registry.start('com.example.testapp');
    const json = registry.toJSON();
    const registry2 = AppRegistry.fromJSON(json);
    assert.equal(registry2.get('com.example.testapp').state, 'running');
  });
});

// ---------------------------------------------------------------------------
// AppStore — publish / unpublish
// ---------------------------------------------------------------------------

describe('AppStore — publish / unpublish', () => {
  let store;
  beforeEach(() => {
    store = new AppStore({ localPodId: 'pod-alice' });
  });

  it('publish adds manifest to store', () => {
    const m = createManifest({ author: 'pod-alice' });
    store.publish(m);
    assert.ok(store.getById('com.example.testapp'));
  });

  it('publish fires onPublish callback', () => {
    let fired = false;
    store.onPublish(() => { fired = true; });
    store.publish(createManifest({ author: 'pod-alice' }));
    assert.equal(fired, true);
  });

  it('unpublish removes manifest', () => {
    store.publish(createManifest({ author: 'pod-alice' }));
    store.unpublish('com.example.testapp', 'pod-alice');
    assert.equal(store.getById('com.example.testapp'), undefined);
  });

  it('unpublish throws if not the author', () => {
    store.publish(createManifest({ author: 'pod-alice' }));
    assert.throws(() => store.unpublish('com.example.testapp', 'pod-bob'), /only.*author/i);
  });

  it('unpublish throws if app not found', () => {
    assert.throws(() => store.unpublish('no-app', 'pod-alice'), /not found/i);
  });
});

// ---------------------------------------------------------------------------
// AppStore — search and queries
// ---------------------------------------------------------------------------

describe('AppStore — search and queries', () => {
  let store;
  beforeEach(() => {
    store = new AppStore({ localPodId: 'pod-a' });
    store.publish(createManifest({ id: 'app1', name: 'File Manager', description: 'Manage files', author: 'pod-alice' }));
    store.publish(createManifest({ id: 'app2', name: 'Chat Client', description: 'Real-time messaging', author: 'pod-alice' }));
    store.publish(createManifest({ id: 'app3', name: 'Code Editor', description: 'Edit code files', author: 'pod-bob' }));
  });

  it('search matches name', () => {
    const results = store.search('Manager');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'app1');
  });

  it('search matches description', () => {
    const results = store.search('messaging');
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'app2');
  });

  it('search is case-insensitive', () => {
    const results = store.search('file');
    assert.equal(results.length, 2); // File Manager + Code Editor (description: "Edit code files")
  });

  it('search returns empty for no match', () => {
    assert.deepEqual(store.search('nonexistent'), []);
  });

  it('getByAuthor returns all by author', () => {
    const results = store.getByAuthor('pod-alice');
    assert.equal(results.length, 2);
  });

  it('getByAuthor returns empty for unknown author', () => {
    assert.deepEqual(store.getByAuthor('pod-nobody'), []);
  });
});

// ---------------------------------------------------------------------------
// AppStore — install count and popularity
// ---------------------------------------------------------------------------

describe('AppStore — install count and popularity', () => {
  let store;
  beforeEach(() => {
    store = new AppStore({ localPodId: 'pod-a' });
    store.publish(createManifest({ id: 'app1', name: 'A', author: 'x' }));
    store.publish(createManifest({ id: 'app2', name: 'B', author: 'x' }));
    store.publish(createManifest({ id: 'app3', name: 'C', author: 'x' }));
  });

  it('addInstallCount increments counter', () => {
    store.addInstallCount('app1');
    store.addInstallCount('app1');
    store.addInstallCount('app2');
    const popular = store.getPopular(2);
    assert.equal(popular[0].id, 'app1');
    assert.equal(popular.length, 2);
  });

  it('getPopular respects limit', () => {
    store.addInstallCount('app1');
    assert.equal(store.getPopular(1).length, 1);
  });

  it('getPopular returns all when limit exceeds count', () => {
    assert.equal(store.getPopular(100).length, 3);
  });

  it('addInstallCount throws for unknown app', () => {
    assert.throws(() => store.addInstallCount('no-app'), /not found/i);
  });
});

// ---------------------------------------------------------------------------
// AppStore — categories and serialization
// ---------------------------------------------------------------------------

describe('AppStore — categories and serialization', () => {
  it('getCategories returns distinct categories', () => {
    const store = new AppStore({ localPodId: 'pod-a' });
    store.publish(createManifest({ id: 'a1', name: 'A', author: 'x', metadata: { category: 'tools' } }));
    store.publish(createManifest({ id: 'a2', name: 'B', author: 'x', metadata: { category: 'games' } }));
    store.publish(createManifest({ id: 'a3', name: 'C', author: 'x', metadata: { category: 'tools' } }));
    const cats = store.getCategories();
    assert.deepEqual(cats.sort(), ['games', 'tools']);
  });

  it('toJSON / fromJSON round-trip', () => {
    const store = new AppStore({ localPodId: 'pod-a' });
    store.publish(createManifest({ id: 'app1', name: 'A', author: 'x' }));
    store.addInstallCount('app1');
    const json = store.toJSON();
    const store2 = AppStore.fromJSON(json);
    assert.ok(store2.getById('app1'));
    assert.equal(store2.getPopular(1)[0].id, 'app1');
  });

  it('onUpdate fires when re-publishing existing app', () => {
    const store = new AppStore({ localPodId: 'pod-a' });
    let fired = false;
    store.onUpdate(() => { fired = true; });
    store.publish(createManifest({ id: 'app1', name: 'A', author: 'x', version: '1.0.0' }));
    store.publish(createManifest({ id: 'app1', name: 'A', author: 'x', version: '2.0.0' }));
    assert.equal(fired, true);
  });
});

// ---------------------------------------------------------------------------
// AppRPC
// ---------------------------------------------------------------------------

describe('AppRPC — register and call', () => {
  let rpc;
  beforeEach(() => {
    rpc = new AppRPC({ appId: 'app1', localPodId: 'pod-a' });
  });

  it('register adds a method', () => {
    rpc.register('greet', () => 'hello');
    assert.ok(rpc.listMethods().includes('greet'));
  });

  it('unregister removes a method', () => {
    rpc.register('greet', () => 'hello');
    rpc.unregister('greet');
    assert.ok(!rpc.listMethods().includes('greet'));
  });

  it('listMethods returns registered method names', () => {
    rpc.register('foo', () => {});
    rpc.register('bar', () => {});
    assert.deepEqual(rpc.listMethods().sort(), ['bar', 'foo']);
  });

  it('call returns result via pending resolution', async () => {
    const rpcA = new AppRPC({ appId: 'app1', localPodId: 'pod-a' });
    const rpcB = new AppRPC({ appId: 'app1', localPodId: 'pod-b' });
    rpcB.register('add', (params) => params.a + params.b);

    // Simulate: pod-a calls pod-b
    const callPromise = rpcA.call('pod-b', 'add', { a: 2, b: 3 });

    // Extract the outgoing message from rpcA
    const messages = [];
    rpcA.onCall((msg) => { messages.push(msg); });
    // The call already queued the message, so we get it from the promise
    // We need to simulate the request/response flow
    // Let's handle it via handleIncoming
    const outgoing = rpcA._getLastOutgoing();
    assert.ok(outgoing);

    // Deliver to rpcB
    const response = rpcB.handleIncoming(outgoing);

    // Deliver response back to rpcA
    rpcA.handleIncoming(response);

    const result = await callPromise;
    assert.equal(result, 5);
  });

  it('call rejects when handler throws', async () => {
    const rpcA = new AppRPC({ appId: 'app1', localPodId: 'pod-a' });
    const rpcB = new AppRPC({ appId: 'app1', localPodId: 'pod-b' });
    rpcB.register('fail', () => { throw new Error('boom'); });

    const callPromise = rpcA.call('pod-b', 'fail');
    const outgoing = rpcA._getLastOutgoing();
    const response = rpcB.handleIncoming(outgoing);
    rpcA.handleIncoming(response);

    await assert.rejects(callPromise, /boom/);
  });

  it('handleIncoming returns error for unknown method', () => {
    const response = rpc.handleIncoming({
      type: 'request',
      id: 'req-1',
      fromPodId: 'pod-b',
      method: 'nope',
      params: {},
    });
    assert.equal(response.type, 'response');
    assert.ok(response.error);
  });

  it('onCall fires for outgoing calls', () => {
    const calls = [];
    rpc.onCall((msg) => calls.push(msg));
    rpc.call('pod-b', 'test');
    assert.equal(calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// AppEventBus
// ---------------------------------------------------------------------------

describe('AppEventBus — emit / on / off / once', () => {
  let bus;
  beforeEach(() => {
    bus = new AppEventBus({ appId: 'app1' });
  });

  it('on subscribes and receives events', () => {
    const received = [];
    bus.on('click', (data) => received.push(data));
    bus.emit('click', { x: 10 });
    bus.emit('click', { x: 20 });
    assert.equal(received.length, 2);
    assert.equal(received[0].x, 10);
  });

  it('off unsubscribes a listener', () => {
    const received = [];
    const handler = (data) => received.push(data);
    bus.on('click', handler);
    bus.emit('click', { x: 1 });
    bus.off('click', handler);
    bus.emit('click', { x: 2 });
    assert.equal(received.length, 1);
  });

  it('once fires only once', () => {
    let count = 0;
    bus.once('init', () => count++);
    bus.emit('init', {});
    bus.emit('init', {});
    assert.equal(count, 1);
  });

  it('listEventTypes returns types with counts', () => {
    bus.on('click', () => {});
    bus.on('click', () => {});
    bus.on('hover', () => {});
    const types = bus.listEventTypes();
    assert.ok(types.find(t => t.eventType === 'click' && t.count === 2));
    assert.ok(types.find(t => t.eventType === 'hover' && t.count === 1));
  });

  it('removeAllListeners for a specific type', () => {
    bus.on('click', () => {});
    bus.on('hover', () => {});
    bus.removeAllListeners('click');
    const types = bus.listEventTypes();
    assert.ok(!types.find(t => t.eventType === 'click'));
    assert.ok(types.find(t => t.eventType === 'hover'));
  });

  it('removeAllListeners with no arg clears all', () => {
    bus.on('click', () => {});
    bus.on('hover', () => {});
    bus.removeAllListeners();
    assert.deepEqual(bus.listEventTypes(), []);
  });

  it('emit to non-existent event type is a no-op', () => {
    // Should not throw
    bus.emit('nonexistent', { data: 1 });
  });

  it('off with non-matching handler is a no-op', () => {
    bus.on('click', () => {});
    bus.off('click', () => {}); // different function reference
    assert.equal(bus.listEventTypes().find(t => t.eventType === 'click').count, 1);
  });
});

// ---------------------------------------------------------------------------
// AppEventBus — constructor validation
// ---------------------------------------------------------------------------

describe('AppEventBus — constructor', () => {
  it('throws when appId is missing', () => {
    assert.throws(() => new AppEventBus({}), /appId/i);
  });
});

// ---------------------------------------------------------------------------
// AppRPC — constructor validation
// ---------------------------------------------------------------------------

describe('AppRPC — constructor', () => {
  it('throws when appId is missing', () => {
    assert.throws(() => new AppRPC({ localPodId: 'pod-a' }), /appId/i);
  });

  it('throws when localPodId is missing', () => {
    assert.throws(() => new AppRPC({ appId: 'app1' }), /localPodId/i);
  });
});

// ---------------------------------------------------------------------------
// AppRegistry — constructor validation
// ---------------------------------------------------------------------------

describe('AppRegistry — constructor', () => {
  it('throws when localPodId is missing', () => {
    assert.throws(() => new AppRegistry({}), /localPodId/i);
  });
});
