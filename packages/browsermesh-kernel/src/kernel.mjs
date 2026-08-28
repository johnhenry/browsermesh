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
   */
  constructor({ clock, rng, tracerOpts, loggerOpts, resourceOpts } = {}) {
    this.#clock = clock || new Clock();
    this.#rng = rng || new RNG();
    this.#resources = new ResourceTable(resourceOpts);
    this.#tracer = new Tracer({ clock: this.#clock, ...tracerOpts });
    this.#logger = new Logger({ tracer: this.#tracer, ...loggerOpts });
    this.#chaos = new ChaosEngine({ rng: this.#rng, clock: this.#clock });
    this.#services = new ServiceRegistry();
    this.#signals = new SignalController();
    this.#startTime = this.#clock.nowWall();
  }

  /** The kernel's resource table. */
  get resources() { return this.#resources; }

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
    const caps = buildCaps(this, capabilities);
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
