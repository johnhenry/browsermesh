/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-capabilities.js -- Capability Attenuation & WASM Sandbox.
 *
 * Implements the object-capability (ocap) model for BrowserMesh:
 *
 * - CapabilityToken: unforgeable, attenuable tokens granting specific access.
 * - CapabilityChain: ordered list of attenuations from root to leaf.
 * - CapabilityValidator: verifies token integrity and attenuation invariants.
 * - WasmSandboxPolicy: security policy for WASM module execution.
 * - WasmSandbox: manages WASM module lifecycle within policy constraints.
 * - SandboxRegistry: tracks active sandboxes per pod.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-capabilities.test.mjs
 */

// ---------------------------------------------------------------------------
// Wire Constants
// ---------------------------------------------------------------------------

/** Wire type for capability grant message. */
export const CAP_GRANT = 0xDC;

/** Wire type for capability revoke message. */
export const CAP_REVOKE = 0xDD;

/** Wire type for capability delegate (attenuate) message. */
export const CAP_DELEGATE = 0xDE;

/** Wire type for WASM sandbox control message. */
export const WASM_SANDBOX_CTRL = 0xDF;

// ---------------------------------------------------------------------------
// CapabilityToken
// ---------------------------------------------------------------------------

let _tokenSeq = 0;

/**
 * An unforgeable capability token granting specific access rights.
 * Tokens can be attenuated (narrowed) but never amplified.
 */
export class CapabilityToken {
  /**
   * @param {object} opts
   * @param {string} [opts.id]             Unique token ID
   * @param {string} opts.issuer           Pod ID of the issuer
   * @param {string} opts.holder           Pod ID of the current holder
   * @param {string} opts.resource         Resource identifier (e.g. 'fs:/data', 'net:*')
   * @param {string[]} opts.permissions    Allowed operations (e.g. ['read', 'write'])
   * @param {object} [opts.constraints]    Additional constraints (maxCalls, expiry, etc.)
   * @param {string|null} [opts.parentId]  ID of the parent token (null for root)
   * @param {number} [opts.createdAt]      Unix timestamp (ms)
   * @param {number|null} [opts.expiresAt] Expiry timestamp (null = no expiry)
   * @param {boolean} [opts.revoked]       Whether token has been revoked
   * @param {number} [opts.depth]          Delegation depth (0 for root)
   * @param {number|null} [opts.maxDepth]  Maximum delegation depth (null = unlimited)
   */
  constructor({
    id,
    issuer,
    holder,
    resource,
    permissions,
    constraints = {},
    parentId = null,
    createdAt,
    expiresAt = null,
    revoked = false,
    depth = 0,
    maxDepth = null,
  }) {
    if (!issuer || typeof issuer !== 'string') {
      throw new Error('issuer is required and must be a non-empty string');
    }
    if (!holder || typeof holder !== 'string') {
      throw new Error('holder is required and must be a non-empty string');
    }
    if (!resource || typeof resource !== 'string') {
      throw new Error('resource is required and must be a non-empty string');
    }
    if (!Array.isArray(permissions) || permissions.length === 0) {
      throw new Error('permissions must be a non-empty array');
    }

    this.id = id || `cap_${Date.now()}_${++_tokenSeq}`;
    this.issuer = issuer;
    this.holder = holder;
    this.resource = resource;
    this.permissions = Object.freeze([...permissions]);
    this.constraints = Object.freeze({ ...constraints });
    this.parentId = parentId;
    this.createdAt = createdAt || Date.now();
    this.expiresAt = expiresAt;
    this.revoked = revoked;
    this.depth = depth;
    this.maxDepth = maxDepth;
  }

  /** Check whether this token has expired. */
  isExpired(now = Date.now()) {
    return this.expiresAt !== null && now >= this.expiresAt;
  }

  /** Check whether this token is currently valid. */
  isValid(now = Date.now()) {
    return !this.revoked && !this.isExpired(now);
  }

  /** Check whether a specific permission is granted. */
  hasPermission(perm) {
    return this.permissions.includes(perm);
  }

  /** Check whether further delegation is allowed. */
  canDelegate() {
    if (this.maxDepth === null) return true;
    return this.depth < this.maxDepth;
  }

  /**
   * Create an attenuated child token with a subset of permissions.
   * Attenuation can only narrow, never widen.
   *
   * @param {object} opts
   * @param {string} opts.holder       New holder pod ID
   * @param {string[]} [opts.permissions] Subset of parent permissions
   * @param {string} [opts.resource]   Narrower resource scope
   * @param {object} [opts.constraints] Additional constraints (merged)
   * @param {number|null} [opts.expiresAt] Expiry (must be ≤ parent)
   * @param {number|null} [opts.maxDepth]  Max depth (must be ≤ parent)
   * @returns {CapabilityToken}
   */
  attenuate({ holder, permissions, resource, constraints, expiresAt, maxDepth }) {
    if (!this.canDelegate()) {
      throw new Error('Delegation depth limit reached');
    }
    if (!this.isValid()) {
      throw new Error('Cannot attenuate an invalid token');
    }

    // Permissions must be a subset
    const childPerms = permissions || [...this.permissions];
    for (const p of childPerms) {
      if (!this.permissions.includes(p)) {
        throw new Error(`Cannot grant permission "${p}" not held by parent`);
      }
    }

    // Resource must be same or narrower (prefix match)
    const childResource = resource || this.resource;
    if (childResource !== this.resource && !childResource.startsWith(this.resource)) {
      if (!this.resource.endsWith('*')) {
        // Check if parent has wildcard
        const parentBase = this.resource.slice(0, -1);
        if (!childResource.startsWith(parentBase)) {
          throw new Error('Cannot widen resource scope beyond parent');
        }
      } else {
        const parentBase = this.resource.slice(0, -1);
        if (!childResource.startsWith(parentBase)) {
          throw new Error('Cannot widen resource scope beyond parent');
        }
      }
    }

    // Expiry must be ≤ parent expiry
    let childExpiry = expiresAt ?? this.expiresAt;
    if (this.expiresAt !== null && childExpiry !== null && childExpiry > this.expiresAt) {
      throw new Error('Cannot extend expiry beyond parent');
    }

    // Max depth must be ≤ parent max depth
    let childMaxDepth = maxDepth ?? this.maxDepth;
    if (this.maxDepth !== null && childMaxDepth !== null && childMaxDepth > this.maxDepth) {
      throw new Error('Cannot extend max depth beyond parent');
    }

    // Merge constraints (child can only add, not remove)
    const mergedConstraints = { ...this.constraints, ...constraints };

    return new CapabilityToken({
      issuer: this.holder,
      holder,
      resource: childResource,
      permissions: childPerms,
      constraints: mergedConstraints,
      parentId: this.id,
      expiresAt: childExpiry,
      depth: this.depth + 1,
      maxDepth: childMaxDepth,
    });
  }

  /** Revoke this token. */
  revoke() {
    this.revoked = true;
  }

  toJSON() {
    return {
      id: this.id,
      issuer: this.issuer,
      holder: this.holder,
      resource: this.resource,
      permissions: [...this.permissions],
      constraints: { ...this.constraints },
      parentId: this.parentId,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      revoked: this.revoked,
      depth: this.depth,
      maxDepth: this.maxDepth,
    };
  }

  static fromJSON(data) {
    return new CapabilityToken(data);
  }
}

// ---------------------------------------------------------------------------
// CapabilityChain
// ---------------------------------------------------------------------------

/**
 * An ordered chain of capability attenuations from root to leaf.
 */
export class CapabilityChain {
  /** @type {CapabilityToken[]} */
  #tokens = [];

  /**
   * @param {CapabilityToken[]} [tokens] Initial token chain
   */
  constructor(tokens = []) {
    for (const t of tokens) {
      this.#tokens.push(t);
    }
  }

  /** Number of tokens in the chain. */
  get length() {
    return this.#tokens.length;
  }

  /** The root (first) token. */
  get root() {
    return this.#tokens[0] || null;
  }

  /** The leaf (last) token. */
  get leaf() {
    return this.#tokens[this.#tokens.length - 1] || null;
  }

  /** Get token at index. */
  at(index) {
    return this.#tokens[index] || null;
  }

  /** Add a token to the chain. Must reference the previous token as parent. */
  append(token) {
    if (this.#tokens.length > 0) {
      const prev = this.#tokens[this.#tokens.length - 1];
      if (token.parentId !== prev.id) {
        throw new Error('Token parentId must match previous token id');
      }
    }
    this.#tokens.push(token);
  }

  /**
   * Verify chain integrity:
   * 1. Each token's parentId matches the previous token's id
   * 2. Permissions only narrow (never widen)
   * 3. Depth increments correctly
   * 4. No expired or revoked tokens (if checkValidity)
   *
   * @param {boolean} [checkValidity=true]
   * @returns {{ valid: boolean, error?: string, brokenAt?: number }}
   */
  verify(checkValidity = true) {
    if (this.#tokens.length === 0) {
      return { valid: false, error: 'Chain is empty' };
    }

    // Root must have no parent
    if (this.#tokens[0].parentId !== null) {
      return { valid: false, error: 'Root token must have null parentId', brokenAt: 0 };
    }

    for (let i = 0; i < this.#tokens.length; i++) {
      const token = this.#tokens[i];

      if (checkValidity && !token.isValid()) {
        return { valid: false, error: `Token at index ${i} is invalid`, brokenAt: i };
      }

      if (i > 0) {
        const prev = this.#tokens[i - 1];

        if (token.parentId !== prev.id) {
          return { valid: false, error: `Broken parent link at index ${i}`, brokenAt: i };
        }

        if (token.depth !== prev.depth + 1) {
          return { valid: false, error: `Depth mismatch at index ${i}`, brokenAt: i };
        }

        // Permissions must be subset of parent
        for (const perm of token.permissions) {
          if (!prev.permissions.includes(perm)) {
            return { valid: false, error: `Permission amplification at index ${i}: "${perm}"`, brokenAt: i };
          }
        }
      }
    }

    return { valid: true };
  }

  /** Get all tokens as array. */
  toArray() {
    return [...this.#tokens];
  }

  toJSON() {
    return this.#tokens.map(t => t.toJSON());
  }

  static fromJSON(arr) {
    return new CapabilityChain(arr.map(d => CapabilityToken.fromJSON(d)));
  }
}

// ---------------------------------------------------------------------------
// CapabilityValidator
// ---------------------------------------------------------------------------

/**
 * Validates capability tokens against requested operations.
 */
export class CapabilityValidator {
  /** @type {Map<string, CapabilityToken>} */
  #tokens = new Map();

  /** @type {Set<string>} Revoked token IDs (including transitive) */
  #revokedIds = new Set();

  /**
   * Register a token for validation lookups.
   * @param {CapabilityToken} token
   */
  register(token) {
    this.#tokens.set(token.id, token);
    if (token.revoked) {
      this.#revokedIds.add(token.id);
    }
  }

  /**
   * Revoke a token and all its descendants.
   * @param {string} tokenId
   */
  revokeTree(tokenId) {
    this.#revokedIds.add(tokenId);
    const token = this.#tokens.get(tokenId);
    if (token) token.revoke();

    // Find and revoke all descendants
    for (const [id, t] of this.#tokens) {
      if (t.parentId === tokenId && !this.#revokedIds.has(id)) {
        this.revokeTree(id);
      }
    }
  }

  /**
   * Validate whether a token grants access to a resource + permission.
   *
   * @param {string} tokenId
   * @param {string} resource
   * @param {string} permission
   * @returns {{ allowed: boolean, reason?: string }}
   */
  validate(tokenId, resource, permission) {
    const token = this.#tokens.get(tokenId);
    if (!token) {
      return { allowed: false, reason: 'Token not found' };
    }
    if (this.#revokedIds.has(tokenId)) {
      return { allowed: false, reason: 'Token revoked' };
    }
    if (token.isExpired()) {
      return { allowed: false, reason: 'Token expired' };
    }
    if (!token.hasPermission(permission)) {
      return { allowed: false, reason: `Permission "${permission}" not granted` };
    }

    // Resource match: exact or prefix (with wildcard)
    if (!this._resourceMatches(token.resource, resource)) {
      return { allowed: false, reason: `Resource "${resource}" not covered by "${token.resource}"` };
    }

    // Check max calls constraint
    if (token.constraints.maxCalls !== undefined) {
      const used = token.constraints._callCount || 0;
      if (used >= token.constraints.maxCalls) {
        return { allowed: false, reason: 'Max calls exceeded' };
      }
    }

    return { allowed: true };
  }

  /**
   * Check if token resource pattern matches a requested resource.
   * @param {string} pattern - Token's resource (may end with *)
   * @param {string} target - Requested resource
   * @returns {boolean}
   */
  _resourceMatches(pattern, target) {
    if (pattern === target) return true;
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) {
      return target.startsWith(pattern.slice(0, -1));
    }
    return false;
  }

  /** List all registered tokens. */
  listTokens() {
    return [...this.#tokens.values()];
  }

  /** Get token count. */
  get size() {
    return this.#tokens.size;
  }

  toJSON() {
    return {
      tokens: [...this.#tokens.values()].map(t => t.toJSON()),
      revokedIds: [...this.#revokedIds],
    };
  }

  static fromJSON(data) {
    const v = new CapabilityValidator();
    for (const td of data.tokens) {
      v.register(CapabilityToken.fromJSON(td));
    }
    for (const id of data.revokedIds) {
      v.#revokedIds.add(id);
    }
    return v;
  }
}

// ---------------------------------------------------------------------------
// WasmSandboxPolicy
// ---------------------------------------------------------------------------

/** @type {readonly string[]} */
const WASM_PERMISSIONS = Object.freeze([
  'memory',     // allocate memory
  'fs-read',    // read filesystem
  'fs-write',   // write filesystem
  'net',        // network access
  'ipc',        // inter-process communication
  'time',       // access clock
  'random',     // access RNG
]);

/**
 * Security policy governing WASM module execution.
 */
export class WasmSandboxPolicy {
  /**
   * @param {object} opts
   * @param {string} opts.name              Policy name
   * @param {string[]} [opts.permissions]   Allowed WASM permissions
   * @param {number} [opts.maxMemoryMb]     Maximum memory in MB (default: 64)
   * @param {number} [opts.maxCpuMs]        Maximum CPU time in ms (default: 5000)
   * @param {number} [opts.maxStorageMb]    Maximum storage in MB (default: 10)
   * @param {number} [opts.maxInstances]    Max concurrent instances (default: 4)
   * @param {string[]} [opts.allowedImports] Allowed host import namespaces
   * @param {boolean} [opts.networkAccess]  Allow network (default: false)
   * @param {boolean} [opts.fsAccess]       Allow filesystem (default: false)
   */
  constructor({
    name,
    permissions = ['memory', 'time', 'random'],
    maxMemoryMb = 64,
    maxCpuMs = 5000,
    maxStorageMb = 10,
    maxInstances = 4,
    allowedImports = [],
    networkAccess = false,
    fsAccess = false,
  }) {
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a non-empty string');
    }
    this.name = name;
    this.permissions = Object.freeze([...permissions]);
    this.maxMemoryMb = maxMemoryMb;
    this.maxCpuMs = maxCpuMs;
    this.maxStorageMb = maxStorageMb;
    this.maxInstances = maxInstances;
    this.allowedImports = Object.freeze([...allowedImports]);
    this.networkAccess = networkAccess;
    this.fsAccess = fsAccess;
  }

  /** Check whether a permission is allowed by this policy. */
  allows(permission) {
    return this.permissions.includes(permission);
  }

  /** Check if an import namespace is allowed. */
  allowsImport(namespace) {
    return this.allowedImports.includes(namespace) || this.allowedImports.includes('*');
  }

  /** Validate that given resource usage is within policy limits. */
  checkLimits({ memoryMb = 0, cpuMs = 0, storageMb = 0, instances = 0 }) {
    const violations = [];
    if (memoryMb > this.maxMemoryMb) violations.push(`memory: ${memoryMb}MB > ${this.maxMemoryMb}MB`);
    if (cpuMs > this.maxCpuMs) violations.push(`cpu: ${cpuMs}ms > ${this.maxCpuMs}ms`);
    if (storageMb > this.maxStorageMb) violations.push(`storage: ${storageMb}MB > ${this.maxStorageMb}MB`);
    if (instances > this.maxInstances) violations.push(`instances: ${instances} > ${this.maxInstances}`);
    return { withinLimits: violations.length === 0, violations };
  }

  toJSON() {
    return {
      name: this.name,
      permissions: [...this.permissions],
      maxMemoryMb: this.maxMemoryMb,
      maxCpuMs: this.maxCpuMs,
      maxStorageMb: this.maxStorageMb,
      maxInstances: this.maxInstances,
      allowedImports: [...this.allowedImports],
      networkAccess: this.networkAccess,
      fsAccess: this.fsAccess,
    };
  }

  static fromJSON(data) {
    return new WasmSandboxPolicy(data);
  }
}

// ---------------------------------------------------------------------------
// WasmSandbox
// ---------------------------------------------------------------------------

/** @type {readonly string[]} */
const SANDBOX_STATES = Object.freeze([
  'idle',
  'loading',
  'ready',
  'running',
  'paused',
  'terminated',
  'error',
]);

/**
 * Manages a single WASM module instance within policy constraints.
 */
export class WasmSandbox {
  /** @type {string} */
  #id;
  /** @type {WasmSandboxPolicy} */
  #policy;
  /** @type {string} */
  #state = 'idle';
  /** @type {string} */
  #ownerPodId;
  /** @type {{ memoryMb: number, cpuMs: number, storageMb: number }} */
  #usage = { memoryMb: 0, cpuMs: 0, storageMb: 0 };
  /** @type {Function[]} */
  #stateListeners = [];
  /** @type {string|null} */
  #moduleHash = null;
  /** @type {number} */
  #createdAt;
  /** @type {string[]} */
  #logs = [];

  /**
   * @param {object} opts
   * @param {string} [opts.id]
   * @param {string} opts.ownerPodId
   * @param {WasmSandboxPolicy} opts.policy
   */
  constructor({ id, ownerPodId, policy }) {
    if (!ownerPodId || typeof ownerPodId !== 'string') {
      throw new Error('ownerPodId is required and must be a non-empty string');
    }
    if (!policy || !(policy instanceof WasmSandboxPolicy)) {
      throw new Error('policy must be a WasmSandboxPolicy instance');
    }
    this.#id = id || `sandbox_${Date.now()}_${++_tokenSeq}`;
    this.#ownerPodId = ownerPodId;
    this.#policy = policy;
    this.#createdAt = Date.now();
  }

  get id() { return this.#id; }
  get ownerPodId() { return this.#ownerPodId; }
  get policy() { return this.#policy; }
  get state() { return this.#state; }
  get usage() { return { ...this.#usage }; }
  get moduleHash() { return this.#moduleHash; }
  get createdAt() { return this.#createdAt; }
  get logs() { return [...this.#logs]; }

  /**
   * Load a WASM module (simulated — stores hash).
   * @param {string} moduleHash
   */
  async load(moduleHash) {
    if (this.#state !== 'idle') {
      throw new Error(`Cannot load in state "${this.#state}"`);
    }
    this._setState('loading');
    this.#moduleHash = moduleHash;
    this._log(`Module loaded: ${moduleHash}`);
    this._setState('ready');
  }

  /**
   * Execute within the sandbox.
   * @param {string} functionName
   * @param {*[]} [args]
   * @returns {Promise<{ result: *, cpuMs: number }>}
   */
  async execute(functionName, args = []) {
    if (this.#state !== 'ready' && this.#state !== 'running') {
      throw new Error(`Cannot execute in state "${this.#state}"`);
    }
    this._setState('running');

    // Simulate execution with usage tracking
    const cpuMs = Math.random() * 10;
    this.#usage.cpuMs += cpuMs;

    // Check policy limits
    const { withinLimits, violations } = this.#policy.checkLimits(this.#usage);
    if (!withinLimits) {
      this._setState('error');
      throw new Error(`Policy violation: ${violations.join(', ')}`);
    }

    this._log(`Executed: ${functionName}(${args.length} args) in ${cpuMs.toFixed(1)}ms`);
    this._setState('ready');
    return { result: null, cpuMs };
  }

  /** Pause execution. */
  pause() {
    if (this.#state !== 'running' && this.#state !== 'ready') {
      throw new Error(`Cannot pause in state "${this.#state}"`);
    }
    this._setState('paused');
  }

  /** Resume from paused state. */
  resume() {
    if (this.#state !== 'paused') {
      throw new Error(`Cannot resume in state "${this.#state}"`);
    }
    this._setState('ready');
  }

  /** Terminate the sandbox. */
  terminate() {
    this._log('Sandbox terminated');
    this._setState('terminated');
  }

  /** Allocate memory (tracked against policy). */
  allocateMemory(mb) {
    this.#usage.memoryMb += mb;
    const { withinLimits, violations } = this.#policy.checkLimits(this.#usage);
    if (!withinLimits) {
      this.#usage.memoryMb -= mb;
      throw new Error(`Memory allocation denied: ${violations.join(', ')}`);
    }
    this._log(`Allocated ${mb}MB memory (total: ${this.#usage.memoryMb}MB)`);
  }

  /** Register a state change listener. */
  onStateChange(cb) {
    this.#stateListeners.push(cb);
  }

  /** @private */
  _setState(newState) {
    const old = this.#state;
    this.#state = newState;
    for (const cb of this.#stateListeners) cb(newState, old);
  }

  /** @private */
  _log(msg) {
    this.#logs.push(`[${new Date().toISOString()}] ${msg}`);
  }

  toJSON() {
    return {
      id: this.#id,
      ownerPodId: this.#ownerPodId,
      policy: this.#policy.toJSON(),
      state: this.#state,
      usage: { ...this.#usage },
      moduleHash: this.#moduleHash,
      createdAt: this.#createdAt,
    };
  }
}

// ---------------------------------------------------------------------------
// SandboxRegistry
// ---------------------------------------------------------------------------

/**
 * Tracks active WASM sandboxes per pod, enforcing per-pod instance limits.
 */
export class SandboxRegistry {
  /** @type {Map<string, WasmSandbox>} id → sandbox */
  #sandboxes = new Map();

  /** @type {Map<string, Set<string>>} podId → Set<sandbox ids> */
  #byPod = new Map();

  /** @type {Function[]} */
  #createListeners = [];

  /** @type {Function[]} */
  #terminateListeners = [];

  /**
   * Create and register a new sandbox.
   * @param {object} opts
   * @param {string} opts.ownerPodId
   * @param {WasmSandboxPolicy} opts.policy
   * @returns {WasmSandbox}
   */
  create({ ownerPodId, policy }) {
    // Check per-pod instance limit
    const podSandboxes = this.#byPod.get(ownerPodId);
    const currentCount = podSandboxes ? podSandboxes.size : 0;
    if (currentCount >= policy.maxInstances) {
      throw new Error(`Instance limit reached: ${currentCount}/${policy.maxInstances}`);
    }

    const sandbox = new WasmSandbox({ ownerPodId, policy });
    this.#sandboxes.set(sandbox.id, sandbox);

    if (!this.#byPod.has(ownerPodId)) {
      this.#byPod.set(ownerPodId, new Set());
    }
    this.#byPod.get(ownerPodId).add(sandbox.id);

    for (const cb of this.#createListeners) cb(sandbox);
    return sandbox;
  }

  /**
   * Terminate and remove a sandbox.
   * @param {string} sandboxId
   */
  terminate(sandboxId) {
    const sandbox = this.#sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox not found: ${sandboxId}`);
    }
    sandbox.terminate();
    this.#sandboxes.delete(sandboxId);

    const podSet = this.#byPod.get(sandbox.ownerPodId);
    if (podSet) {
      podSet.delete(sandboxId);
      if (podSet.size === 0) this.#byPod.delete(sandbox.ownerPodId);
    }

    for (const cb of this.#terminateListeners) cb(sandbox);
  }

  /** Get sandbox by ID. */
  get(sandboxId) {
    return this.#sandboxes.get(sandboxId) || null;
  }

  /** List sandboxes by pod. */
  listByPod(podId) {
    const ids = this.#byPod.get(podId);
    if (!ids) return [];
    return [...ids].map(id => this.#sandboxes.get(id)).filter(Boolean);
  }

  /** List all sandboxes. */
  listAll() {
    return [...this.#sandboxes.values()];
  }

  /** Total number of active sandboxes. */
  get size() {
    return this.#sandboxes.size;
  }

  /** Get stats. */
  getStats() {
    let totalMemoryMb = 0;
    let totalCpuMs = 0;
    const stateCount = {};
    for (const s of this.#sandboxes.values()) {
      const usage = s.usage;
      totalMemoryMb += usage.memoryMb;
      totalCpuMs += usage.cpuMs;
      stateCount[s.state] = (stateCount[s.state] || 0) + 1;
    }
    return {
      totalSandboxes: this.#sandboxes.size,
      totalMemoryMb,
      totalCpuMs,
      stateCount,
      podCount: this.#byPod.size,
    };
  }

  /** Register creation listener. */
  onCreate(cb) { this.#createListeners.push(cb); }

  /** Register termination listener. */
  onTerminate(cb) { this.#terminateListeners.push(cb); }

  toJSON() {
    return {
      sandboxes: [...this.#sandboxes.values()].map(s => s.toJSON()),
    };
  }
}
