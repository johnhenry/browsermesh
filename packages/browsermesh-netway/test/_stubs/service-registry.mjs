/**
 * ServiceRegistry stub — copied from browsermesh-kernel for standalone testing.
 */

class AlreadyRegisteredError extends Error {
  constructor(name) {
    super(`Already registered: ${name}`);
    this.name = 'AlreadyRegisteredError';
  }
}

class NotFoundError extends Error {
  constructor(name) {
    super(`Not found: ${name}`);
    this.name = 'NotFoundError';
  }
}

export class ServiceRegistry {
  #services = new Map();
  #onRegisterCbs = [];
  #onUnregisterCbs = [];
  #onLookupMissCbs = [];

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

  unregister(name) {
    const entry = this.#services.get(name);
    if (!entry) throw new NotFoundError(name);
    this.#services.delete(name);
    for (const cb of this.#onUnregisterCbs) {
      try { cb(entry); } catch (_) {}
    }
  }

  async lookup(name) {
    const entry = this.#services.get(name);
    if (entry) return entry;
    for (const cb of this.#onLookupMissCbs) {
      try {
        const result = await cb(name);
        if (result) return result;
      } catch (_) {}
    }
    throw new NotFoundError(name);
  }

  has(name) { return this.#services.has(name); }
  list() { return [...this.#services.keys()]; }

  onRegister(cb) {
    this.#onRegisterCbs.push(cb);
    return () => {
      const idx = this.#onRegisterCbs.indexOf(cb);
      if (idx >= 0) this.#onRegisterCbs.splice(idx, 1);
    };
  }

  onUnregister(cb) {
    this.#onUnregisterCbs.push(cb);
    return () => {
      const idx = this.#onUnregisterCbs.indexOf(cb);
      if (idx >= 0) this.#onUnregisterCbs.splice(idx, 1);
    };
  }

  onLookupMiss(cb) {
    this.#onLookupMissCbs.push(cb);
    return () => {
      const idx = this.#onLookupMissCbs.indexOf(cb);
      if (idx >= 0) this.#onLookupMissCbs.splice(idx, 1);
    };
  }

  registerRemote(name, nodeId, metadata = {}) {
    this.register(name, null, {
      metadata: { ...metadata, remote: true, nodeId },
      owner: nodeId,
    });
  }

  clear() {
    this.#services.clear();
    this.#onRegisterCbs.length = 0;
    this.#onUnregisterCbs.length = 0;
    this.#onLookupMissCbs.length = 0;
  }
}
