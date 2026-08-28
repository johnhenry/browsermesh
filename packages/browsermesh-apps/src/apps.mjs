/**
 * clawser-mesh-apps.js -- Decentralized App Ecosystem for BrowserMesh.
 *
 * Provides a full app lifecycle for mesh-distributed applications:
 * manifest definition, installation, permission checking, a distributed
 * app store, inter-app RPC, and pub/sub eventing.
 *
 * Classes:
 *   AppManifest, AppInstance, AppPermissionChecker, AppRegistry,
 *   AppStore, AppRPC, AppEventBus
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-apps.test.mjs
 */

import { MESH_TYPE } from '@johnhenry/browsermesh-primitives';
import { silentCatch } from './silent-catch.mjs'

// ---------------------------------------------------------------------------
// Wire Constants (re-exported from canonical registry)
// ---------------------------------------------------------------------------

export const APP_MANIFEST = MESH_TYPE.APP_MANIFEST;        // 0xe5
export const APP_INSTALL = MESH_TYPE.APP_INSTALL;          // 0xe6
export const APP_UNINSTALL = MESH_TYPE.APP_UNINSTALL;      // 0xe7
export const APP_STATE_SYNC = MESH_TYPE.APP_STATE_SYNC;    // 0xe8
export const APP_RPC = MESH_TYPE.APP_RPC;                  // 0xe9
export const APP_EVENT = MESH_TYPE.APP_EVENT;              // 0xea

// ---------------------------------------------------------------------------
// Valid permissions
// ---------------------------------------------------------------------------

/** @type {readonly string[]} */
const VALID_PERMISSIONS = Object.freeze([
  'net', 'fs', 'identity', 'mesh', 'payment', 'compute', 'storage',
]);

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/**
 * Check if a string matches semver-like x.y.z format.
 *
 * @param {string} v
 * @returns {boolean}
 */
function isValidVersion(v) {
  return /^\d+\.\d+\.\d+$/.test(v);
}

/**
 * Compare two semver-like version strings.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// ---------------------------------------------------------------------------
// AppManifest
// ---------------------------------------------------------------------------

/**
 * Describes a mesh-distributed app.
 *
 * @class
 */
export class AppManifest {
  /**
   * @param {object} opts
   * @param {string} opts.id - Unique app identifier
   * @param {string} opts.name - Human-readable name
   * @param {string} opts.version - Semver-like version (x.y.z)
   * @param {string|null} [opts.description]
   * @param {string|null} [opts.author] - Pod ID of the author
   * @param {string[]} opts.permissions - Required permissions
   * @param {string} opts.entryPoint - URL or path to app entry
   * @param {Array<{id: string, minVersion?: string}>} [opts.dependencies]
   * @param {number} [opts.minPeers]
   * @param {number|null} [opts.maxPeers]
   * @param {object} [opts.metadata]
   * @param {number|null} [opts.publishedAt]
   * @param {string|null} [opts.signature]
   */
  constructor({
    id,
    name,
    version,
    description = null,
    author = null,
    permissions = [],
    entryPoint,
    dependencies = [],
    minPeers = 1,
    maxPeers = null,
    metadata = {},
    publishedAt = null,
    signature = null,
  } = {}) {
    if (!id) throw new Error('id is required');
    if (!name) throw new Error('name is required');
    if (!version) throw new Error('version is required');
    if (!entryPoint) throw new Error('entryPoint is required');

    this.id = id;
    this.name = name;
    this.version = version;
    this.description = description;
    this.author = author;
    this.permissions = [...permissions];
    this.entryPoint = entryPoint;
    this.dependencies = dependencies.map((d) => ({ ...d }));
    this.minPeers = minPeers;
    this.maxPeers = maxPeers;
    this.metadata = { ...metadata };
    this.publishedAt = publishedAt;
    this.signature = signature;
  }

  /**
   * Validate the manifest: required fields, version format.
   *
   * @returns {boolean}
   */
  validate() {
    if (!this.id || !this.name || !this.version || !this.entryPoint) {
      return false;
    }
    if (!isValidVersion(this.version)) {
      return false;
    }
    return true;
  }

  /**
   * Check whether this manifest satisfies a given dependency.
   *
   * @param {{ id: string, minVersion?: string }} dep
   * @returns {boolean}
   */
  satisfiesDependency(dep) {
    if (this.id !== dep.id) return false;
    if (dep.minVersion) {
      return compareVersions(this.version, dep.minVersion) >= 0;
    }
    return true;
  }

  /**
   * Serialize to a plain JSON-safe object.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      author: this.author,
      permissions: [...this.permissions],
      entryPoint: this.entryPoint,
      dependencies: this.dependencies.map((d) => ({ ...d })),
      minPeers: this.minPeers,
      maxPeers: this.maxPeers,
      metadata: { ...this.metadata },
      publishedAt: this.publishedAt,
      signature: this.signature,
    };
  }

  /**
   * Deserialize from a plain object.
   *
   * @param {object} data
   * @returns {AppManifest}
   */
  static fromJSON(data) {
    return new AppManifest(data);
  }
}

// ---------------------------------------------------------------------------
// AppInstance
// ---------------------------------------------------------------------------

/**
 * Valid app states.
 * @type {readonly string[]}
 */
const APP_STATES = Object.freeze([
  'installed', 'starting', 'running', 'paused', 'stopping', 'stopped', 'error',
]);

/**
 * A running instance of an app.
 *
 * @class
 */
export class AppInstance {
  /** @type {AppManifest} */
  manifest;

  /** @type {string} */
  installedBy;

  /** @type {number} */
  installedAt;

  /** @type {string} */
  #state;

  /** @type {object} */
  #data;

  /** @type {string[]} */
  #peers;

  /**
   * @param {object} opts
   * @param {AppManifest} opts.manifest
   * @param {string} opts.installedBy - Pod ID of the installer
   * @param {number} [opts.installedAt]
   * @param {string} [opts.state]
   * @param {object} [opts.data]
   * @param {string[]} [opts.peers]
   */
  constructor({
    manifest,
    installedBy,
    installedAt = Date.now(),
    state = 'installed',
    data = {},
    peers = [],
  } = {}) {
    if (!manifest) throw new Error('manifest is required');
    if (!installedBy) throw new Error('installedBy is required');

    this.manifest = manifest;
    this.installedBy = installedBy;
    this.installedAt = installedAt;
    this.#state = state;
    this.#data = { ...data };
    this.#peers = [...peers];
  }

  // -- Accessors ------------------------------------------------------------

  /** App ID from manifest. */
  get id() {
    return this.manifest.id;
  }

  /** App name from manifest. */
  get name() {
    return this.manifest.name;
  }

  /** Current state. */
  get state() {
    return this.#state;
  }

  /** Current app data (copy). */
  get data() {
    return { ...this.#data };
  }

  /** Current peers (copy). */
  get peers() {
    return [...this.#peers];
  }

  // -- State transitions ----------------------------------------------------

  /**
   * Start the app: installed/paused -> starting -> running.
   * Throws if current state does not allow starting.
   */
  start() {
    if (this.#state !== 'installed' && this.#state !== 'paused') {
      throw new Error(`Cannot start app in state '${this.#state}'`);
    }
    this.#state = 'starting';
    this.#state = 'running';
  }

  /**
   * Pause the app: running -> paused.
   * Throws if not running.
   */
  pause() {
    if (this.#state !== 'running') {
      throw new Error(`Cannot pause app in state '${this.#state}'`);
    }
    this.#state = 'paused';
  }

  /**
   * Stop the app: any active state -> stopping -> stopped.
   * Throws if already stopped.
   */
  stop() {
    if (this.#state === 'stopped') {
      throw new Error(`Cannot stop app in state '${this.#state}'`);
    }
    this.#state = 'stopping';
    this.#state = 'stopped';
  }

  /**
   * Transition to error state.
   *
   * @param {string} error - Error description
   */
  setError(error) {
    this.#state = 'error';
    this._lastError = error;
  }

  // -- Data management ------------------------------------------------------

  /**
   * Merge patch into app data.
   *
   * @param {object} patch
   */
  updateData(patch) {
    Object.assign(this.#data, patch);
  }

  // -- Peer management ------------------------------------------------------

  /**
   * Add a participating peer. Idempotent.
   *
   * @param {string} podId
   */
  addPeer(podId) {
    if (!this.#peers.includes(podId)) {
      this.#peers.push(podId);
    }
  }

  /**
   * Remove a participating peer. Safe for non-existent.
   *
   * @param {string} podId
   */
  removePeer(podId) {
    this.#peers = this.#peers.filter((p) => p !== podId);
  }

  /**
   * Check if a peer is participating.
   *
   * @param {string} podId
   * @returns {boolean}
   */
  hasPeer(podId) {
    return this.#peers.includes(podId);
  }

  // -- Serialization --------------------------------------------------------

  /**
   * Serialize to a plain JSON-safe object.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      manifest: this.manifest.toJSON(),
      installedBy: this.installedBy,
      installedAt: this.installedAt,
      state: this.#state,
      data: { ...this.#data },
      peers: [...this.#peers],
    };
  }

  /**
   * Deserialize from a plain object.
   *
   * @param {object} data
   * @returns {AppInstance}
   */
  static fromJSON(data) {
    return new AppInstance({
      manifest: AppManifest.fromJSON(data.manifest),
      installedBy: data.installedBy,
      installedAt: data.installedAt,
      state: data.state,
      data: data.data,
      peers: data.peers,
    });
  }
}

// ---------------------------------------------------------------------------
// AppPermissionChecker
// ---------------------------------------------------------------------------

/**
 * Validates app permission requests against a granted set.
 *
 * @class
 */
export class AppPermissionChecker {
  /** @type {Set<string>} */
  #granted;

  /**
   * @param {object} opts
   * @param {string[]} [opts.grantedPermissions]
   */
  constructor({ grantedPermissions = [] } = {}) {
    this.#granted = new Set(grantedPermissions);
  }

  /**
   * Check if a permission is granted.
   *
   * @param {string} permission
   * @returns {boolean}
   */
  check(permission) {
    return this.#granted.has(permission);
  }

  /**
   * Check multiple permissions at once.
   *
   * @param {string[]} permissions
   * @returns {{ granted: string[], denied: string[] }}
   */
  checkAll(permissions) {
    const granted = [];
    const denied = [];
    for (const p of permissions) {
      if (this.#granted.has(p)) {
        granted.push(p);
      } else {
        denied.push(p);
      }
    }
    return { granted, denied };
  }

  /**
   * Grant a permission. Idempotent.
   *
   * @param {string} permission
   */
  grant(permission) {
    this.#granted.add(permission);
  }

  /**
   * Revoke a permission. Safe for non-existent.
   *
   * @param {string} permission
   */
  revoke(permission) {
    this.#granted.delete(permission);
  }

  /**
   * List all granted permissions.
   *
   * @returns {string[]}
   */
  listGranted() {
    return [...this.#granted];
  }
}

// ---------------------------------------------------------------------------
// AppRegistry
// ---------------------------------------------------------------------------

/**
 * Manages installed apps for a local pod.
 *
 * @class
 */
export class AppRegistry {
  /** @type {string} */
  #localPodId;

  /** @type {Map<string, AppInstance>} appId -> instance */
  #apps = new Map();

  /** @type {Map<string, AppPermissionChecker>} appId -> checker */
  #permissions = new Map();

  /** @type {Function[]} */
  #installCallbacks = [];

  /** @type {Function[]} */
  #uninstallCallbacks = [];

  /** @type {Function[]} */
  #stateChangeCallbacks = [];

  /**
   * @param {object} opts
   * @param {string} opts.localPodId
   */
  constructor({ localPodId } = {}) {
    if (!localPodId) throw new Error('localPodId is required');
    this.#localPodId = localPodId;
  }

  /**
   * Install an app from a manifest.
   *
   * @param {AppManifest} manifest
   * @param {string[]} [grantPermissions] - Permissions to grant (subset of manifest.permissions)
   * @returns {AppInstance}
   */
  install(manifest, grantPermissions) {
    if (!manifest.validate()) {
      throw new Error('Invalid manifest: validation failed');
    }
    if (this.#apps.has(manifest.id)) {
      throw new Error(`App '${manifest.id}' is already installed`);
    }

    const inst = new AppInstance({
      manifest,
      installedBy: this.#localPodId,
    });

    const checker = new AppPermissionChecker({
      grantedPermissions: grantPermissions || manifest.permissions,
    });

    this.#apps.set(manifest.id, inst);
    this.#permissions.set(manifest.id, checker);
    this.#fire(this.#installCallbacks, inst);
    return inst;
  }

  /**
   * Uninstall an app by ID.
   *
   * @param {string} appId
   */
  uninstall(appId) {
    const inst = this.#apps.get(appId);
    if (!inst) throw new Error(`App '${appId}' not found`);

    // Stop if active
    if (inst.state !== 'stopped' && inst.state !== 'error') {
      try { inst.stop(); } catch (e) { silentCatch('clawser-mesh-apps', 'inst.stop', e) }
    }

    this.#apps.delete(appId);
    this.#permissions.delete(appId);
    this.#fire(this.#uninstallCallbacks, appId);
  }

  /**
   * Get an AppInstance by ID.
   *
   * @param {string} appId
   * @returns {AppInstance|undefined}
   */
  get(appId) {
    return this.#apps.get(appId);
  }

  /**
   * List installed apps, optionally filtering.
   *
   * @param {object} [filter]
   * @param {string} [filter.state] - Filter by state
   * @param {string} [filter.author] - Filter by author
   * @param {string} [filter.name] - Filter by name substring
   * @returns {AppInstance[]}
   */
  list(filter) {
    let results = [...this.#apps.values()];
    if (filter) {
      if (filter.state) {
        results = results.filter((i) => i.state === filter.state);
      }
      if (filter.author) {
        results = results.filter((i) => i.manifest.author === filter.author);
      }
      if (filter.name) {
        const lower = filter.name.toLowerCase();
        results = results.filter((i) => i.manifest.name.toLowerCase().includes(lower));
      }
    }
    return results;
  }

  /**
   * Start an app by ID.
   *
   * @param {string} appId
   */
  start(appId) {
    const inst = this.#apps.get(appId);
    if (!inst) throw new Error(`App '${appId}' not found`);
    inst.start();
    this.#fire(this.#stateChangeCallbacks, appId, inst.state);
  }

  /**
   * Pause an app by ID.
   *
   * @param {string} appId
   */
  pause(appId) {
    const inst = this.#apps.get(appId);
    if (!inst) throw new Error(`App '${appId}' not found`);
    inst.pause();
    this.#fire(this.#stateChangeCallbacks, appId, inst.state);
  }

  /**
   * Stop an app by ID.
   *
   * @param {string} appId
   */
  stop(appId) {
    const inst = this.#apps.get(appId);
    if (!inst) throw new Error(`App '${appId}' not found`);
    inst.stop();
    this.#fire(this.#stateChangeCallbacks, appId, inst.state);
  }

  /**
   * Update an app to a new version. Stops the old version, replaces manifest,
   * restarts if the old version was running.
   *
   * @param {string} appId
   * @param {AppManifest} newManifest
   */
  update(appId, newManifest) {
    const inst = this.#apps.get(appId);
    if (!inst) throw new Error(`App '${appId}' not found`);
    if (!newManifest.validate()) {
      throw new Error('Invalid manifest: validation failed');
    }

    const wasRunning = inst.state === 'running';

    // Stop if active
    if (inst.state !== 'stopped' && inst.state !== 'installed' && inst.state !== 'error') {
      try { inst.stop(); } catch (e) { silentCatch('clawser-mesh-apps', 'inst.stop', e) }
    }

    // Create new instance with new manifest, preserving data
    const newInst = new AppInstance({
      manifest: newManifest,
      installedBy: inst.installedBy,
      installedAt: inst.installedAt,
      data: inst.data,
      peers: inst.peers,
    });

    this.#apps.set(appId, newInst);

    if (wasRunning) {
      newInst.start();
      this.#fire(this.#stateChangeCallbacks, appId, newInst.state);
    }
  }

  /**
   * Get apps using a specific permission.
   *
   * @param {string} permission
   * @returns {AppInstance[]}
   */
  getByPermission(permission) {
    const results = [];
    for (const [appId, inst] of this.#apps) {
      if (inst.manifest.permissions.includes(permission)) {
        results.push(inst);
      }
    }
    return results;
  }

  /**
   * Register a callback for install events.
   *
   * @param {Function} cb - Receives (AppInstance)
   */
  onInstall(cb) {
    this.#installCallbacks.push(cb);
  }

  /**
   * Register a callback for uninstall events.
   *
   * @param {Function} cb - Receives (appId)
   */
  onUninstall(cb) {
    this.#uninstallCallbacks.push(cb);
  }

  /**
   * Register a callback for state change events.
   *
   * @param {Function} cb - Receives (appId, newState)
   */
  onStateChange(cb) {
    this.#stateChangeCallbacks.push(cb);
  }

  /**
   * Get aggregate stats about installed apps.
   *
   * @returns {{ totalInstalled: number, running: number, paused: number, stopped: number }}
   */
  getStats() {
    let running = 0;
    let paused = 0;
    let stopped = 0;
    for (const inst of this.#apps.values()) {
      if (inst.state === 'running') running++;
      else if (inst.state === 'paused') paused++;
      else if (inst.state === 'stopped') stopped++;
    }
    return {
      totalInstalled: this.#apps.size,
      running,
      paused,
      stopped,
    };
  }

  /**
   * Serialize to a JSON-safe object.
   *
   * @returns {object}
   */
  toJSON() {
    const apps = {};
    for (const [id, inst] of this.#apps) {
      apps[id] = inst.toJSON();
    }
    return {
      localPodId: this.#localPodId,
      apps,
    };
  }

  /**
   * Deserialize from a plain object.
   *
   * @param {object} data
   * @returns {AppRegistry}
   */
  static fromJSON(data) {
    const registry = new AppRegistry({ localPodId: data.localPodId });
    for (const [id, instData] of Object.entries(data.apps)) {
      const inst = AppInstance.fromJSON(instData);
      registry.#apps.set(id, inst);
      registry.#permissions.set(id, new AppPermissionChecker({
        grantedPermissions: inst.manifest.permissions,
      }));
    }
    return registry;
  }

  // -- Private Helpers ------------------------------------------------------

  /**
   * Fire all callbacks in a list, swallowing listener errors.
   *
   * @param {Function[]} callbacks
   * @param {...*} args
   */
  #fire(callbacks, ...args) {
    for (const cb of callbacks) {
      try {
        cb(...args);
      } catch {
        /* listener errors do not propagate */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// AppStore
// ---------------------------------------------------------------------------

/**
 * Distributed app store across the mesh.
 *
 * @class
 */
export class AppStore {
  /** @type {string} */
  #localPodId;

  /** @type {Map<string, AppManifest>} appId -> manifest */
  #manifests = new Map();

  /** @type {Map<string, number>} appId -> install count */
  #installCounts = new Map();

  /** @type {Function[]} */
  #publishCallbacks = [];

  /** @type {Function[]} */
  #updateCallbacks = [];

  /**
   * @param {object} opts
   * @param {string} opts.localPodId
   */
  constructor({ localPodId } = {}) {
    if (!localPodId) throw new Error('localPodId is required');
    this.#localPodId = localPodId;
  }

  /**
   * Publish an app manifest to the store.
   * If the app already exists, this is treated as an update.
   *
   * @param {AppManifest} manifest
   */
  publish(manifest) {
    const existing = this.#manifests.has(manifest.id);
    this.#manifests.set(manifest.id, manifest);
    if (!this.#installCounts.has(manifest.id)) {
      this.#installCounts.set(manifest.id, 0);
    }
    if (existing) {
      this.#fire(this.#updateCallbacks, manifest);
    } else {
      this.#fire(this.#publishCallbacks, manifest);
    }
  }

  /**
   * Unpublish an app from the store. Only the author may unpublish.
   *
   * @param {string} appId
   * @param {string} requesterPodId - Must match the manifest author
   */
  unpublish(appId, requesterPodId) {
    const manifest = this.#manifests.get(appId);
    if (!manifest) throw new Error(`App '${appId}' not found in store`);
    if (manifest.author !== requesterPodId) {
      throw new Error('Only the author can unpublish an app');
    }
    this.#manifests.delete(appId);
    this.#installCounts.delete(appId);
  }

  /**
   * Text search across app name and description.
   *
   * @param {string} query
   * @returns {AppManifest[]}
   */
  search(query) {
    const lower = query.toLowerCase();
    const results = [];
    for (const m of this.#manifests.values()) {
      const nameMatch = m.name.toLowerCase().includes(lower);
      const descMatch = m.description && m.description.toLowerCase().includes(lower);
      if (nameMatch || descMatch) {
        results.push(m);
      }
    }
    return results;
  }

  /**
   * Find a manifest by ID.
   *
   * @param {string} appId
   * @returns {AppManifest|undefined}
   */
  getById(appId) {
    return this.#manifests.get(appId);
  }

  /**
   * Get all apps by an author.
   *
   * @param {string} authorPodId
   * @returns {AppManifest[]}
   */
  getByAuthor(authorPodId) {
    const results = [];
    for (const m of this.#manifests.values()) {
      if (m.author === authorPodId) {
        results.push(m);
      }
    }
    return results;
  }

  /**
   * Get most installed apps, sorted by install count descending.
   *
   * @param {number} [limit=10]
   * @returns {AppManifest[]}
   */
  getPopular(limit = 10) {
    const sorted = [...this.#manifests.keys()]
      .sort((a, b) => (this.#installCounts.get(b) || 0) - (this.#installCounts.get(a) || 0))
      .slice(0, limit);
    return sorted.map((id) => this.#manifests.get(id));
  }

  /**
   * Increment the install counter for an app.
   *
   * @param {string} appId
   */
  addInstallCount(appId) {
    if (!this.#manifests.has(appId)) {
      throw new Error(`App '${appId}' not found in store`);
    }
    this.#installCounts.set(appId, (this.#installCounts.get(appId) || 0) + 1);
  }

  /**
   * Get distinct categories from all manifests' metadata.
   *
   * @returns {string[]}
   */
  getCategories() {
    const cats = new Set();
    for (const m of this.#manifests.values()) {
      if (m.metadata && m.metadata.category) {
        cats.add(m.metadata.category);
      }
    }
    return [...cats];
  }

  /**
   * Register a callback for publish events (new apps).
   *
   * @param {Function} cb - Receives (AppManifest)
   */
  onPublish(cb) {
    this.#publishCallbacks.push(cb);
  }

  /**
   * Register a callback for update events (re-published apps).
   *
   * @param {Function} cb - Receives (AppManifest)
   */
  onUpdate(cb) {
    this.#updateCallbacks.push(cb);
  }

  /**
   * Serialize to a JSON-safe object.
   *
   * @returns {object}
   */
  toJSON() {
    const manifests = {};
    for (const [id, m] of this.#manifests) {
      manifests[id] = m.toJSON();
    }
    const installCounts = {};
    for (const [id, count] of this.#installCounts) {
      installCounts[id] = count;
    }
    return {
      localPodId: this.#localPodId,
      manifests,
      installCounts,
    };
  }

  /**
   * Deserialize from a plain object.
   *
   * @param {object} data
   * @returns {AppStore}
   */
  static fromJSON(data) {
    const store = new AppStore({ localPodId: data.localPodId });
    for (const [id, mData] of Object.entries(data.manifests)) {
      store.#manifests.set(id, AppManifest.fromJSON(mData));
    }
    for (const [id, count] of Object.entries(data.installCounts)) {
      store.#installCounts.set(id, count);
    }
    return store;
  }

  // -- Private Helpers ------------------------------------------------------

  /**
   * Fire all callbacks in a list, swallowing listener errors.
   *
   * @param {Function[]} callbacks
   * @param {...*} args
   */
  #fire(callbacks, ...args) {
    for (const cb of callbacks) {
      try {
        cb(...args);
      } catch {
        /* listener errors do not propagate */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// AppRPC
// ---------------------------------------------------------------------------

/**
 * Inter-app and cross-pod RPC for apps.
 *
 * @class
 */
export class AppRPC {
  /** @type {string} */
  #appId;

  /** @type {string} */
  #localPodId;

  /** @type {Map<string, Function>} method -> handler */
  #methods = new Map();

  /** @type {Map<string, { resolve: Function, reject: Function }>} requestId -> pending */
  #pending = new Map();

  /** @type {Function[]} */
  #callCallbacks = [];

  /** @type {number} */
  #nextId = 1;

  /** @type {object|null} */
  #lastOutgoing = null;

  /**
   * @param {object} opts
   * @param {string} opts.appId
   * @param {string} opts.localPodId
   */
  constructor({ appId, localPodId } = {}) {
    if (!appId) throw new Error('appId is required');
    if (!localPodId) throw new Error('localPodId is required');
    this.#appId = appId;
    this.#localPodId = localPodId;
  }

  /**
   * Register an RPC method.
   *
   * @param {string} method
   * @param {Function} handler - Receives (params) and returns result or throws
   */
  register(method, handler) {
    this.#methods.set(method, handler);
  }

  /**
   * Remove an RPC method.
   *
   * @param {string} method
   */
  unregister(method) {
    this.#methods.delete(method);
  }

  /**
   * Call a remote method on another pod.
   * Returns a promise that resolves when the response arrives.
   *
   * @param {string} targetPodId
   * @param {string} method
   * @param {*} [params]
   * @returns {Promise<*>}
   */
  async call(targetPodId, method, params) {
    const id = `rpc-${this.#nextId++}`;
    const message = {
      type: 'request',
      id,
      fromPodId: this.#localPodId,
      targetPodId,
      appId: this.#appId,
      method,
      params: params || {},
    };

    this.#lastOutgoing = message;

    const promise = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });

    this.#fire(this.#callCallbacks, message);

    return promise;
  }

  /**
   * List registered method names.
   *
   * @returns {string[]}
   */
  listMethods() {
    return [...this.#methods.keys()];
  }

  /**
   * Process an incoming RPC message.
   * If it is a request, dispatch to the registered handler and return a response.
   * If it is a response, resolve the pending promise.
   *
   * @param {object} message
   * @returns {object|undefined} Response message for requests, undefined for responses
   */
  handleIncoming(message) {
    if (message.type === 'request') {
      const handler = this.#methods.get(message.method);
      if (!handler) {
        return {
          type: 'response',
          id: message.id,
          fromPodId: this.#localPodId,
          targetPodId: message.fromPodId,
          appId: this.#appId,
          result: null,
          error: `Method '${message.method}' not found`,
        };
      }

      try {
        const result = handler(message.params);
        return {
          type: 'response',
          id: message.id,
          fromPodId: this.#localPodId,
          targetPodId: message.fromPodId,
          appId: this.#appId,
          result,
          error: null,
        };
      } catch (err) {
        return {
          type: 'response',
          id: message.id,
          fromPodId: this.#localPodId,
          targetPodId: message.fromPodId,
          appId: this.#appId,
          result: null,
          error: err.message,
        };
      }
    }

    if (message.type === 'response') {
      const pending = this.#pending.get(message.id);
      if (pending) {
        this.#pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve(message.result);
        }
      }
    }

    return undefined;
  }

  /**
   * Register a callback for outgoing calls (for transport layer).
   *
   * @param {Function} cb - Receives (message)
   */
  onCall(cb) {
    this.#callCallbacks.push(cb);
  }

  /**
   * Get the last outgoing message (for testing transport simulation).
   *
   * @returns {object|null}
   */
  _getLastOutgoing() {
    return this.#lastOutgoing;
  }

  // -- Private Helpers ------------------------------------------------------

  /**
   * Fire all callbacks in a list, swallowing listener errors.
   *
   * @param {Function[]} callbacks
   * @param {...*} args
   */
  #fire(callbacks, ...args) {
    for (const cb of callbacks) {
      try {
        cb(...args);
      } catch {
        /* listener errors do not propagate */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// AppEventBus
// ---------------------------------------------------------------------------

/**
 * Pub/sub event system for apps.
 *
 * @class
 */
export class AppEventBus {
  /** @type {string} */
  #appId;

  /** @type {Map<string, Function[]>} eventType -> listeners */
  #listeners = new Map();

  /**
   * @param {object} opts
   * @param {string} opts.appId
   */
  constructor({ appId } = {}) {
    if (!appId) throw new Error('appId is required');
    this.#appId = appId;
  }

  /**
   * Publish an event to all subscribers.
   *
   * @param {string} eventType
   * @param {*} data
   */
  emit(eventType, data) {
    const listeners = this.#listeners.get(eventType);
    if (!listeners) return;
    for (const cb of [...listeners]) {
      try {
        cb(data);
      } catch {
        /* listener errors do not propagate */
      }
    }
  }

  /**
   * Subscribe to an event type.
   *
   * @param {string} eventType
   * @param {Function} cb
   */
  on(eventType, cb) {
    if (!this.#listeners.has(eventType)) {
      this.#listeners.set(eventType, []);
    }
    this.#listeners.get(eventType).push(cb);
  }

  /**
   * Unsubscribe from an event type.
   *
   * @param {string} eventType
   * @param {Function} cb
   */
  off(eventType, cb) {
    const listeners = this.#listeners.get(eventType);
    if (!listeners) return;
    const idx = listeners.indexOf(cb);
    if (idx >= 0) {
      listeners.splice(idx, 1);
    }
    if (listeners.length === 0) {
      this.#listeners.delete(eventType);
    }
  }

  /**
   * Subscribe to an event type for one event only.
   *
   * @param {string} eventType
   * @param {Function} cb
   */
  once(eventType, cb) {
    const wrapper = (data) => {
      this.off(eventType, wrapper);
      cb(data);
    };
    this.on(eventType, wrapper);
  }

  /**
   * List active event types with subscriber counts.
   *
   * @returns {Array<{ eventType: string, count: number }>}
   */
  listEventTypes() {
    const types = [];
    for (const [eventType, listeners] of this.#listeners) {
      if (listeners.length > 0) {
        types.push({ eventType, count: listeners.length });
      }
    }
    return types;
  }

  /**
   * Remove all listeners, optionally for a specific event type.
   *
   * @param {string} [eventType] - If omitted, clears all event types
   */
  removeAllListeners(eventType) {
    if (eventType !== undefined) {
      this.#listeners.delete(eventType);
    } else {
      this.#listeners.clear();
    }
  }
}
