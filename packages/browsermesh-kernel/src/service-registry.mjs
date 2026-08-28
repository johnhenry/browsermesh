/**
 * ServiceRegistry — convention-based svc:// service registry.
 *
 * Manages named services with registration, lookup, and lifecycle callbacks.
 * Services are identified by string names (convention: `svc://name`).
 *
 * @module service-registry
 */

import { AlreadyRegisteredError, NotFoundError } from './errors.mjs';

/**
 * Registry for named services with lifecycle event callbacks.
 */
export class ServiceRegistry {
  #services = new Map();
  #onRegisterCbs = [];
  #onUnregisterCbs = [];
  #onLookupMissCbs = [];

  /**
   * Register a named service.
   *
   * @param {string} name - Service name.
   * @param {*} listener - The service listener/handler.
   * @param {Object} [opts={}]
   * @param {Object} [opts.metadata] - Arbitrary metadata about the service.
   * @param {string} [opts.owner] - Owner identifier.
   * @throws {AlreadyRegisteredError} If the name is already registered.
   */
  register(name, listener, { metadata, owner } = {}) {
    if (this.#services.has(name)) {
      throw new AlreadyRegisteredError(name);
    }
    const entry = { name, listener, metadata: metadata || {}, owner: owner || null };
    this.#services.set(name, entry);
    for (const cb of this.#onRegisterCbs) {
      try { cb(entry); } catch (_) {}
    }
  }

  /**
   * Unregister a named service.
   *
   * @param {string} name - Service name.
   * @throws {NotFoundError} If the name is not registered.
   */
  unregister(name) {
    const entry = this.#services.get(name);
    if (!entry) throw new NotFoundError(name);
    this.#services.delete(name);
    for (const cb of this.#onUnregisterCbs) {
      try { cb(entry); } catch (_) {}
    }
  }

  /**
   * Look up a service by name. If not found locally, calls onLookupMiss hooks
   * which may resolve the service from remote sources.
   *
   * @param {string} name - Service name.
   * @returns {Promise<{ name: string, listener: *, metadata: Object, owner: string|null }>}
   * @throws {NotFoundError} If the service is not found (locally or via hooks).
   */
  async lookup(name) {
    const entry = this.#services.get(name);
    if (entry) return entry;

    // Try lookup miss hooks (e.g., distributed service resolution)
    for (const cb of this.#onLookupMissCbs) {
      try {
        const result = await cb(name);
        if (result) return result;
      } catch (_) {}
    }

    throw new NotFoundError(name);
  }

  /**
   * Check whether a service is registered.
   *
   * @param {string} name - Service name.
   * @returns {boolean}
   */
  has(name) {
    return this.#services.has(name);
  }

  /**
   * List all registered service names.
   *
   * @returns {string[]}
   */
  list() {
    return [...this.#services.keys()];
  }

  /**
   * Register a callback for service registration events.
   *
   * @param {function(Object): void} cb - Callback receiving the service entry.
   * @returns {function(): void} Unsubscribe function.
   */
  onRegister(cb) {
    this.#onRegisterCbs.push(cb);
    return () => {
      const idx = this.#onRegisterCbs.indexOf(cb);
      if (idx >= 0) this.#onRegisterCbs.splice(idx, 1);
    };
  }

  /**
   * Register a callback for service unregistration events.
   *
   * @param {function(Object): void} cb - Callback receiving the service entry.
   * @returns {function(): void} Unsubscribe function.
   */
  onUnregister(cb) {
    this.#onUnregisterCbs.push(cb);
    return () => {
      const idx = this.#onUnregisterCbs.indexOf(cb);
      if (idx >= 0) this.#onUnregisterCbs.splice(idx, 1);
    };
  }

  /**
   * Register a hook called when lookup() misses locally.
   * Hook receives the service name and may return a service entry
   * or null to let the next hook try.
   *
   * @param {function(string): Promise<Object|null>} cb - Lookup miss handler.
   * @returns {function(): void} Unsubscribe function.
   */
  onLookupMiss(cb) {
    this.#onLookupMissCbs.push(cb);
    return () => {
      const idx = this.#onLookupMissCbs.indexOf(cb);
      if (idx >= 0) this.#onLookupMissCbs.splice(idx, 1);
    };
  }

  /**
   * Register a remote service entry (for distributed service awareness).
   *
   * @param {string} name - Service name.
   * @param {string} nodeId - Remote node identifier.
   * @param {Object} [metadata={}] - Metadata about the remote service.
   * @throws {AlreadyRegisteredError} If the name is already registered.
   */
  registerRemote(name, nodeId, metadata = {}) {
    this.register(name, null, {
      metadata: { ...metadata, remote: true, nodeId },
      owner: nodeId,
    });
  }

  /**
   * Remove all registered services and callbacks.
   */
  clear() {
    this.#services.clear();
    this.#onRegisterCbs.length = 0;
    this.#onUnregisterCbs.length = 0;
    this.#onLookupMissCbs.length = 0;
  }
}
