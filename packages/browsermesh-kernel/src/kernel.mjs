/**
 * Kernel — top-level facade composing all kernel subsystems.
 *
 * Creates and wires ResourceTable, Clock, RNG, Tracer, Logger, ChaosEngine,
 * ServiceRegistry, and SignalController. Provides tenant lifecycle management
 * with capability-scoped access.
 *
 * @module kernel
 */

import { ResourceTable } from './resource-table.mjs';
import { Clock } from './clock.mjs';
import { RNG } from './rng.mjs';
import { Tracer } from './tracer.mjs';
import { Logger } from './logger.mjs';
import { ChaosEngine } from './chaos.mjs';
import { ServiceRegistry } from './service-registry.mjs';
import { SignalController } from './signal.mjs';
import { Environment } from './env.mjs';
import { Stdio } from './stdio.mjs';
import { buildCaps } from './caps.mjs';
import { MeshAccessDeniedError } from './errors.mjs';

/**
 * The Kernel facade. Creates and wires all subsystems.
 */
export class Kernel {
  #resources;
  #clock;
  #rng;
  #tracer;
  #logger;
  #chaos;
  #services;
  #signals;
  #mesh;
  #tenants = new Map();
  #tenantCounter = 0;
  #startTime;

  /**
   * @param {Object} [opts={}]
   * @param {Object} [opts.clock] - Clock instance (defaults to real clock).
   * @param {Object} [opts.rng] - RNG instance (defaults to crypto RNG).
   * @param {Object} [opts.tracerOpts] - Options for Tracer constructor.
   * @param {Object} [opts.loggerOpts] - Options for Logger constructor.
   * @param {Object} [opts.resourceOpts] - Options for ResourceTable constructor.
   * @param {Object} [opts.mesh] - Optional real mesh provider backing the MESH
   *   capability. The kernel has zero dependency on any `@johnhenry/browsermesh-*`
   *   package (including `browsermesh-apps`) -- this is deliberately a
   *   duck-typed interface, not an imported class, so callers must pass an
   *   object shaped like:
   *   `{ sendTo(peerId, data): Promise<void>, onIncomingData(cb): () => void,
   *      registry: { checkAccess(peerId, resource, action): {allowed, reason?} } }`.
   *   `browsermesh-apps`'s `PeerNode` already satisfies this shape as-is (see
   *   `browsermesh-apps/src/kernel-mesh.mjs`, the composition helper that
   *   wires a real `PeerNode` in). Omit to leave the MESH capability as the
   *   pre-Phase-4 bare boolean marker.
   */
  constructor({ clock, rng, tracerOpts, loggerOpts, resourceOpts, mesh } = {}) {
    this.#clock = clock || new Clock();
    this.#rng = rng || new RNG();
    this.#resources = new ResourceTable(resourceOpts);
    this.#tracer = new Tracer({ clock: this.#clock, ...tracerOpts });
    this.#logger = new Logger({ tracer: this.#tracer, ...loggerOpts });
    this.#chaos = new ChaosEngine({ rng: this.#rng, clock: this.#clock });
    this.#services = new ServiceRegistry();
    this.#signals = new SignalController();
    this.#mesh = mesh || null;
    this.#startTime = this.#clock.nowWall();
  }

  /**
   * The kernel's resource table.
   *
   * This is ambient, trusted access: `get`/`getTyped`/`drop` called through this getter do
   * NOT check ownership, so any code holding the kernel reference can reach any tenant's
   * resources by handle. It exists for kernel-internal bookkeeping (e.g. `destroyTenant`)
   * and trusted callers. Tenant-facing code should use {@link Kernel#resourcesFor} instead,
   * which scopes access to a single tenant and enforces ownership on every call.
   */
  get resources() { return this.#resources; }

  /**
   * Get a tenant-scoped view of the resource table, bound to `tenantId`.
   *
   * The returned object exposes `get`/`getTyped`/`drop`, each automatically passing
   * `tenantId` as the `expectedOwner` to the underlying {@link ResourceTable} methods —
   * so a tenant-scoped view can never read or destroy another tenant's resource, even if
   * it guesses the handle. `allocate`/`transfer`/listing methods are intentionally not
   * exposed here: allocation records the owner explicitly at the call site, and transfer/
   * listing are kernel-internal operations, not something arbitrary tenant code should do
   * to itself.
   *
   * @param {string} tenantId - Tenant identifier to scope access to.
   * @returns {{ get: Function, getTyped: Function, drop: Function }} Tenant-scoped resource view.
   */
  resourcesFor(tenantId) {
    return {
      get: (handle) => this.#resources.get(handle, tenantId),
      getTyped: (handle, type) => this.#resources.getTyped(handle, type, tenantId),
      drop: (handle) => this.#resources.drop(handle, tenantId),
    };
  }

  /**
   * The raw injected mesh provider, or `null` if none was supplied to the constructor.
   *
   * This is ambient, trusted access -- like {@link Kernel#resources}, it does NOT
   * gate send/receive by peer access. It exists for kernel-internal use and trusted
   * composition code. Tenant-facing code should use {@link Kernel#meshFor} instead,
   * which scopes access to send/receive only and enforces the provider's
   * `registry.checkAccess()` on every call.
   */
  get mesh() { return this.#mesh; }

  /**
   * Get a tenant-scoped view of the mesh capability, bound to `tenantId`.
   *
   * Returns `null` if no mesh provider was injected via the constructor (the MESH
   * capability then falls back to a bare boolean marker in {@link buildCaps}). When a
   * provider IS present, the returned view exposes exactly two operations -- `send`
   * and `onReceive` -- deliberately not the full `PeerNode` API (no `connectToPeer`,
   * `addPeer`, `removePeer`, `discover`, etc.): a tenant's mesh capability lets it use
   * an already-connected mesh session, not administer one. Every `send`/`onReceive`
   * delivery is checked against the provider's `registry.checkAccess(peerId, 'mesh',
   * 'send'|'receive')`, so a tenant can only reach peers the injected `PeerRegistry`
   * has actually authorized (e.g. via `registry.grantCapabilities(peerId,
   * ['mesh:send', 'mesh:receive'])`) -- not every peer the underlying PeerNode
   * happens to be connected to.
   *
   * @param {string} tenantId - Tenant identifier to scope access to (used for error
   *   attribution in {@link MeshAccessDeniedError}; enforcement itself is per-peer).
   * @returns {{ send: (peerId: string, data: *) => Promise<void>, onReceive: (cb: Function) => (() => void) } | null}
   */
  meshFor(tenantId) {
    if (!this.#mesh) return null;
    const provider = this.#mesh;
    return Object.freeze({
      send: async (peerId, data) => {
        const access = provider.registry.checkAccess(peerId, 'mesh', 'send');
        if (!access || !access.allowed) {
          throw new MeshAccessDeniedError(tenantId, peerId, 'send', access && access.reason);
        }
        return provider.sendTo(peerId, data);
      },
      onReceive: (cb) => {
        if (typeof cb !== 'function') {
          throw new TypeError('meshFor().onReceive: callback must be a function');
        }
        return provider.onIncomingData((peerId, data, meta) => {
          const access = provider.registry.checkAccess(peerId, 'mesh', 'receive');
          if (access && access.allowed) cb(peerId, data, meta);
        });
      },
    });
  }

  /** The kernel clock. */
  get clock() { return this.#clock; }

  /** The kernel RNG. */
  get rng() { return this.#rng; }

  /** The kernel tracer. */
  get tracer() { return this.#tracer; }

  /** The kernel logger (shorthand). */
  get log() { return this.#logger; }

  /** The chaos engine. */
  get chaos() { return this.#chaos; }

  /** The service registry. */
  get services() { return this.#services; }

  /** The signal controller. */
  get signals() { return this.#signals; }

  /** Wall-clock time the kernel was constructed. */
  get startTime() { return this.#startTime; }

  /** Milliseconds elapsed since the kernel was constructed. */
  get uptime() { return this.#clock.nowWall() - this.#startTime; }

  /** Number of currently-active tenants. */
  get tenantCount() { return this.#tenants.size; }

  /**
   * Create a new tenant with scoped capabilities.
   *
   * @param {Object} [opts={}]
   * @param {string[]} [opts.capabilities=[]] - KERNEL_CAP tags to grant.
   * @param {Record<string,string>} [opts.env={}] - Tenant environment variables.
   * @param {Object} [opts.stdio] - Tenant stdio streams ({stdin, stdout, stderr}).
   * @returns {{ id: string, caps: Readonly<Object>, env: Environment, stdio: Stdio, signals: SignalController }}
   */
  createTenant({ capabilities = [], env = {}, stdio } = {}) {
    const id = `tenant_${++this.#tenantCounter}`;
    const caps = buildCaps(this, capabilities, id);
    const tenantEnv = new Environment(env);
    const tenantStdio = new Stdio(stdio || {});
    const tenantSignals = new SignalController();

    const tenant = { id, caps, env: tenantEnv, stdio: tenantStdio, signals: tenantSignals };
    this.#tenants.set(id, tenant);

    this.#logger.info('kernel', `Tenant created: ${id}`, { capabilities });

    return tenant;
  }

  /**
   * Destroy a tenant, dropping all owned resources.
   *
   * @param {string} tenantId - Tenant identifier.
   */
  destroyTenant(tenantId) {
    const tenant = this.#tenants.get(tenantId);
    if (!tenant) return;

    // Drop all resources owned by this tenant
    const handles = this.#resources.listByOwner(tenantId);
    for (const h of handles) {
      try { this.#resources.drop(h); } catch (_) {}
    }

    this.#tenants.delete(tenantId);
    this.#logger.info('kernel', `Tenant destroyed: ${tenantId}`);
  }

  /**
   * Get a tenant by ID.
   *
   * @param {string} tenantId - Tenant identifier.
   * @returns {Object|undefined}
   */
  getTenant(tenantId) {
    return this.#tenants.get(tenantId);
  }

  /**
   * List all tenant IDs.
   *
   * @returns {string[]}
   */
  listTenants() {
    return [...this.#tenants.keys()];
  }

  /**
   * Close the kernel, destroying all tenants and clearing all subsystems.
   */
  close() {
    for (const id of [...this.#tenants.keys()]) {
      this.destroyTenant(id);
    }
    this.#resources.clear();
    this.#services.clear();
    this.#tracer.clear();
    this.#logger.info('kernel', 'Kernel closed');
  }
}
