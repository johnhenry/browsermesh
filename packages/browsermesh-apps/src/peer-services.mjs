/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-peer-services.js -- Service advertising and discovery for P2P mesh.
 *
 * Peers advertise capabilities (agent, terminal, files, compute, http-proxy, model)
 * and others can discover and connect to them.
 *
 * ServiceAdvertiser manages local service advertisements with broadcast to peers.
 * ServiceBrowser tracks remote services discovered from other peers.
 *
 * No browser-only imports at module level. All dependencies injected.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-services.test.mjs
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Well-known service types that peers can advertise.
 */
export const SERVICE_TYPES = Object.freeze({
  AGENT: 'agent',
  TERMINAL: 'terminal',
  FILES: 'files',
  COMPUTE: 'compute',
  MODEL: 'model',
  HTTP_PROXY: 'http-proxy',
})

/** Default TTL for service descriptors (5 minutes). */
export const SERVICE_TTL_DEFAULT = 300_000

// ---------------------------------------------------------------------------
// ServiceDescriptor (plain object factory)
// ---------------------------------------------------------------------------

/**
 * Create a ServiceDescriptor — a plain-object record describing an advertised
 * service on the mesh.
 *
 * @param {object} opts
 * @param {string} opts.name          - Service name (unique per pod)
 * @param {string} opts.type          - One of SERVICE_TYPES values
 * @param {string} opts.podId         - Pod that owns the service
 * @param {string} [opts.version]     - Semver version string
 * @param {string[]} [opts.capabilities] - Fine-grained capability tags
 * @param {object} [opts.pricing]     - Pricing metadata (free-form)
 * @param {object} [opts.metadata]    - Arbitrary metadata
 * @param {string} [opts.address]     - mesh:// address
 * @param {number} [opts.registeredAt]
 * @param {number} [opts.ttl]
 * @returns {object}
 */
function createDescriptor({
  name,
  type,
  podId,
  version = '1.0.0',
  capabilities = [],
  pricing = null,
  metadata = null,
  address = null,
  registeredAt = Date.now(),
  ttl = SERVICE_TTL_DEFAULT,
}) {
  return {
    name,
    type,
    podId,
    version,
    capabilities: [...capabilities],
    pricing: pricing ? { ...pricing } : null,
    metadata: metadata ? { ...metadata } : null,
    address: address ?? `mesh://${podId}/${name}`,
    registeredAt,
    ttl,
  }
}

// ---------------------------------------------------------------------------
// ServiceAdvertiser
// ---------------------------------------------------------------------------

/**
 * Manages services advertised by the local pod and broadcasts changes to
 * connected peers.
 */
export class ServiceAdvertiser {
  /** @type {string} */
  #localPodId

  /** @type {Map<string, object>} name -> ServiceDescriptor */
  #services = new Map()

  /** @type {Function|null} */
  #broadcastFn

  /** @type {Function} */
  #onLog

  /** @type {Map<string, Function[]>} */
  #listeners = new Map()

  /**
   * @param {object} opts
   * @param {string} opts.localPodId    - This pod's identifier
   * @param {Function} [opts.broadcastFn] - (message) => void, broadcast to peers
   * @param {Function} [opts.onLog]     - Logging callback
   */
  constructor({ localPodId, broadcastFn, onLog }) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string')
    }
    this.#localPodId = localPodId
    this.#broadcastFn = broadcastFn ?? null
    this.#onLog = onLog ?? (() => {})
  }

  // ── Advertising ───────────────────────────────────────────────────

  /**
   * Advertise a new service from this pod.
   *
   * @param {object} service
   * @param {string} service.name          - Service name (unique per pod)
   * @param {string} service.type          - Service type (one of SERVICE_TYPES)
   * @param {string} [service.version]     - Version string
   * @param {string[]} [service.capabilities] - Capability tags
   * @param {object} [service.pricing]     - Pricing metadata
   * @param {object} [service.metadata]    - Arbitrary metadata
   * @returns {object} ServiceDescriptor
   */
  advertise(service) {
    if (!service || !service.name || typeof service.name !== 'string') {
      throw new Error('service.name is required and must be a non-empty string')
    }
    if (!service.type || typeof service.type !== 'string') {
      throw new Error('service.type is required and must be a non-empty string')
    }

    const descriptor = createDescriptor({
      name: service.name,
      type: service.type,
      podId: this.#localPodId,
      version: service.version,
      capabilities: service.capabilities,
      pricing: service.pricing,
      metadata: service.metadata,
    })

    this.#services.set(service.name, descriptor)

    // Broadcast to connected peers
    if (this.#broadcastFn) {
      this.#broadcastFn({
        type: 'service:advertise',
        service: descriptor,
      })
    }

    this.#onLog(`Advertised service: ${service.name} (${service.type})`)
    this.#emit('advertise', descriptor)

    return descriptor
  }

  /**
   * Withdraw (remove) a previously advertised service.
   *
   * @param {string} serviceName
   * @returns {boolean} true if the service existed and was removed
   */
  withdraw(serviceName) {
    const descriptor = this.#services.get(serviceName)
    if (!descriptor) return false

    this.#services.delete(serviceName)

    // Broadcast withdrawal to connected peers
    if (this.#broadcastFn) {
      this.#broadcastFn({
        type: 'service:withdraw',
        address: descriptor.address,
        podId: this.#localPodId,
        name: serviceName,
      })
    }

    this.#onLog(`Withdrew service: ${serviceName}`)
    this.#emit('withdraw', descriptor)

    return true
  }

  // ── Queries ───────────────────────────────────────────────────────

  /**
   * List all locally advertised services.
   * @returns {object[]} Array of ServiceDescriptor
   */
  listServices() {
    return [...this.#services.values()]
  }

  /**
   * Get a single advertised service by name.
   * @param {string} name
   * @returns {object|null} ServiceDescriptor or null
   */
  getService(name) {
    return this.#services.get(name) ?? null
  }

  // ── Peer Announcement ─────────────────────────────────────────────

  /**
   * Announce all current services to a newly connected peer.
   *
   * @param {Function} sendFn - (message) => void, sends to the specific peer
   */
  announceToNewPeer(sendFn) {
    if (typeof sendFn !== 'function') {
      throw new Error('sendFn must be a function')
    }
    for (const descriptor of this.#services.values()) {
      sendFn({
        type: 'service:advertise',
        service: descriptor,
      })
    }
  }

  // ── Events ────────────────────────────────────────────────────────

  /**
   * Subscribe to an event.
   * @param {string} event - 'advertise' | 'withdraw'
   * @param {Function} cb
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, [])
    }
    this.#listeners.get(event).push(cb)
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const cbs = this.#listeners.get(event)
    if (!cbs) return
    const idx = cbs.indexOf(cb)
    if (idx !== -1) cbs.splice(idx, 1)
  }

  /**
   * Emit an event to all listeners.
   * @param {string} event
   * @param  {...any} args
   */
  #emit(event, ...args) {
    const cbs = this.#listeners.get(event)
    if (!cbs) return
    for (const cb of [...cbs]) {
      try { cb(...args) } catch { /* listener errors do not propagate */ }
    }
  }

  // ── Serialization ─────────────────────────────────────────────────

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      localPodId: this.#localPodId,
      services: [...this.#services.values()],
    }
  }
}

// ---------------------------------------------------------------------------
// ServiceBrowser
// ---------------------------------------------------------------------------

/**
 * Tracks services discovered from remote peers on the mesh.
 */
export class ServiceBrowser {
  /** @type {Map<string, object>} address -> ServiceDescriptor */
  #remoteServices = new Map()

  /** @type {Map<string, Function[]>} */
  #listeners = new Map()

  /** @type {Function} */
  #onLog

  /**
   * @param {object} [opts]
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor(opts = {}) {
    this.#onLog = opts.onLog ?? (() => {})
  }

  // ── Incoming Messages ─────────────────────────────────────────────

  /**
   * Handle an incoming service advertisement from a peer.
   * Adds or updates the service in the remote services map.
   *
   * @param {object} service - ServiceDescriptor from a peer
   */
  handleAdvertisement(service) {
    if (!service || !service.address) {
      return
    }
    this.#remoteServices.set(service.address, service)
    this.#onLog(`Discovered service: ${service.name} at ${service.address}`)
    this.#emit('discovered', service)
  }

  /**
   * Handle a service withdrawal notification from a peer.
   *
   * @param {string} address - mesh:// address of the withdrawn service
   */
  handleWithdrawal(address) {
    const service = this.#remoteServices.get(address)
    if (!service) return
    this.#remoteServices.delete(address)
    this.#onLog(`Lost service: ${address}`)
    this.#emit('lost', service)
  }

  // ── Discovery Queries ─────────────────────────────────────────────

  /**
   * Discover remote services matching an optional filter.
   *
   * @param {object} [filter]
   * @param {string} [filter.type]       - Filter by service type
   * @param {string} [filter.capability] - Filter by capability tag
   * @param {string} [filter.podId]      - Filter by owning pod
   * @returns {object[]} Array of matching ServiceDescriptor
   */
  discover(filter) {
    const results = []
    for (const svc of this.#remoteServices.values()) {
      if (filter) {
        if (filter.type && svc.type !== filter.type) continue
        if (filter.capability && (!svc.capabilities || !svc.capabilities.includes(filter.capability))) continue
        if (filter.podId && svc.podId !== filter.podId) continue
      }
      results.push(svc)
    }
    return results
  }

  /**
   * Get a single remote service by its mesh address.
   * @param {string} address
   * @returns {object|null}
   */
  getService(address) {
    return this.#remoteServices.get(address) ?? null
  }

  /**
   * Get all services from a specific pod.
   * @param {string} podId
   * @returns {object[]}
   */
  getServicesByPod(podId) {
    const results = []
    for (const svc of this.#remoteServices.values()) {
      if (svc.podId === podId) results.push(svc)
    }
    return results
  }

  /**
   * Get all services of a given type.
   * @param {string} type
   * @returns {object[]}
   */
  getServicesByType(type) {
    const results = []
    for (const svc of this.#remoteServices.values()) {
      if (svc.type === type) results.push(svc)
    }
    return results
  }

  // ── Maintenance ───────────────────────────────────────────────────

  /**
   * Remove services whose TTL has expired.
   *
   * @param {number} [now=Date.now()]
   * @returns {number} Number of services pruned
   */
  pruneExpired(now = Date.now()) {
    let count = 0
    for (const [address, svc] of this.#remoteServices) {
      if (now >= svc.registeredAt + svc.ttl) {
        this.#remoteServices.delete(address)
        this.#emit('lost', svc)
        count++
      }
    }
    return count
  }

  // ── Events ────────────────────────────────────────────────────────

  /**
   * Subscribe to an event.
   * @param {string} event - 'discovered' | 'lost'
   * @param {Function} cb
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, [])
    }
    this.#listeners.get(event).push(cb)
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const cbs = this.#listeners.get(event)
    if (!cbs) return
    const idx = cbs.indexOf(cb)
    if (idx !== -1) cbs.splice(idx, 1)
  }

  /**
   * Emit an event to all listeners.
   * @param {string} event
   * @param  {...any} args
   */
  #emit(event, ...args) {
    const cbs = this.#listeners.get(event)
    if (!cbs) return
    for (const cb of [...cbs]) {
      try { cb(...args) } catch { /* listener errors do not propagate */ }
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────

  /** @returns {number} Number of known remote services */
  get size() {
    return this.#remoteServices.size
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      services: [...this.#remoteServices.values()],
    }
  }
}
