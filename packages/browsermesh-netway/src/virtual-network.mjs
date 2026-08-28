/**
 * VirtualNetwork — the top-level networking facade that composes a {@link Router},
 * {@link PolicyEngine}, and one or more {@link Backend}s into a unified API.
 *
 * Out of the box, a `VirtualNetwork` comes with a {@link LoopbackBackend}
 * registered for the `mem://` and `loop://` schemes. Additional backends (e.g.
 * {@link GatewayBackend} for real TCP/UDP) can be added via
 * {@link VirtualNetwork#addBackend}.
 *
 * For sandboxed or multi-tenant scenarios, call {@link VirtualNetwork#scope} to
 * obtain a {@link ScopedNetwork} that enforces capability-based policies on
 * every operation.
 *
 * @module virtual-network
 */

import { Router, parseAddress } from './router.mjs';
import { PolicyEngine } from './policy.mjs';
import { LoopbackBackend } from './loopback-backend.mjs';
import { CAPABILITY } from './constants.mjs';
import { PolicyDeniedError } from './errors.mjs';

/**
 * Top-level virtual network that routes operations to scheme-specific backends.
 *
 * Provides the same five primitives as {@link Backend} (connect, listen,
 * sendDatagram, bindDatagram, resolve) but accepts full address strings
 * (e.g. `"mem://localhost:8080"`) and automatically routes to the correct backend.
 */
export class VirtualNetwork {
  #router;
  #policyEngine;
  #backends = [];

  /**
   * Create a VirtualNetwork with a default {@link LoopbackBackend} registered
   * for the `mem` and `loop` schemes.
   */
  constructor() {
    this.#router = new Router();
    this.#policyEngine = new PolicyEngine();

    // Register default loopback backend
    const loopback = new LoopbackBackend();
    this.#backends.push(loopback);
    this.#router.addRoute('mem', loopback);
    this.#router.addRoute('loop', loopback);
  }

  /**
   * Register an additional backend for a URI scheme. The backend is also added
   * to the internal list consulted by {@link VirtualNetwork#resolve}.
   *
   * @param {string} scheme - The URI scheme (e.g. `'tcp'`, `'udp'`, `'ws'`).
   * @param {import('./backend.mjs').Backend} backend - The backend implementation.
   */
  addBackend(scheme, backend) {
    this.#backends.push(backend);
    this.#router.addRoute(scheme, backend);
  }

  /** An array of all registered URI scheme strings. */
  get schemes() { return this.#router.schemes; }

  /**
   * Open a stream connection to the given address.
   *
   * @param {string} address - Full address (e.g. `"mem://localhost:8080"`, `"tcp://example.com:443"`).
   * @returns {Promise<import('./stream-socket.mjs').StreamSocket>} A connected stream socket.
   * @throws {UnknownSchemeError} If the address scheme has no registered backend.
   * @throws {ConnectionRefusedError} If the target refuses the connection.
   */
  async connect(address) {
    const { backend, parsed } = this.#router.resolve(address);
    return backend.connect(parsed.host, parsed.port);
  }

  /**
   * Start listening for incoming stream connections on the given address.
   *
   * @param {string} address - Full address (e.g. `"mem://localhost:8080"`). Use port `0`
   *   for auto-assignment.
   * @returns {Promise<import('./listener.mjs').Listener>} A listener bound to the resolved port.
   * @throws {UnknownSchemeError} If the address scheme has no registered backend.
   * @throws {AddressInUseError} If the port is already in use.
   */
  async listen(address) {
    const { backend, parsed } = this.#router.resolve(address);
    return backend.listen(parsed.port);
  }

  /**
   * Send a datagram to the given address.
   *
   * @param {string} address - Full address (e.g. `"mem://localhost:5353"`).
   * @param {Uint8Array} data - The datagram payload.
   * @returns {Promise<void>}
   * @throws {UnknownSchemeError} If the address scheme has no registered backend.
   */
  async sendDatagram(address, data) {
    const { backend, parsed } = this.#router.resolve(address);
    return backend.sendDatagram(parsed.host, parsed.port, data);
  }

  /**
   * Bind a datagram socket on the given address to receive incoming datagrams.
   *
   * @param {string} address - Full address (e.g. `"mem://localhost:0"`). Use port `0`
   *   for auto-assignment.
   * @returns {Promise<import('./datagram-socket.mjs').DatagramSocket>} A bound datagram socket.
   * @throws {UnknownSchemeError} If the address scheme has no registered backend.
   * @throws {AddressInUseError} If the port is already in use.
   */
  async bindDatagram(address) {
    const { backend, parsed } = this.#router.resolve(address);
    return backend.bindDatagram(parsed.port);
  }

  /**
   * Resolve a hostname by querying all registered backends in order. Returns
   * the first successful result or an empty array if all backends fail.
   *
   * @param {string} name - The hostname to resolve.
   * @param {string} [type='A'] - DNS record type (e.g. `'A'`, `'AAAA'`).
   * @returns {Promise<string[]>} An array of resolved address strings, or `[]` if
   *   no backend could resolve the name.
   */
  async resolve(name, type = 'A') {
    // Try all backends; loopback always returns 127.0.0.1
    for (const backend of this.#backends) {
      try {
        return await backend.resolve(name, type);
      } catch {}
    }
    return [];
  }

  /**
   * Create a {@link ScopedNetwork} that enforces capability-based policy checks
   * on every operation before delegating to this network.
   *
   * @param {Object} [opts={}]
   * @param {string[]} [opts.capabilities=[]] - Capability tags to grant (values from
   *   {@link CAPABILITY}).
   * @param {function({ capability: string, address?: string }, Set<string>): Promise<'allow'|'deny'>|'allow'|'deny'} [opts.policy]
   *   Optional custom policy callback. See {@link PolicyEngine#createScope}.
   * @returns {ScopedNetwork} A policy-enforcing wrapper around this network.
   */
  scope({ capabilities = [], policy } = {}) {
    const scopeId = this.#policyEngine.createScope({ capabilities, policy });
    return new ScopedNetwork(this, this.#policyEngine, scopeId);
  }

  /**
   * Close the network and all registered backends, releasing all resources.
   *
   * @returns {Promise<void>}
   */
  async close() {
    for (const backend of this.#backends) {
      await backend.close();
    }
  }
}

/**
 * ScopedNetwork — a policy-enforcing wrapper around a {@link VirtualNetwork}.
 *
 * Every operation first checks whether the scope's capabilities permit it. For
 * `mem://` and `loop://` schemes, the {@link CAPABILITY.LOOPBACK} tag is
 * required; for other schemes, the protocol-specific tag is required (e.g.
 * {@link CAPABILITY.TCP_CONNECT} for stream connections).
 *
 * Obtain an instance via {@link VirtualNetwork#scope}.
 */
export class ScopedNetwork {
  #network;
  #policy;
  #scopeId;

  /**
   * Create a ScopedNetwork. Callers should use {@link VirtualNetwork#scope}
   * instead of constructing directly.
   *
   * @param {VirtualNetwork} network - The underlying network to delegate to.
   * @param {PolicyEngine} policy - The policy engine that owns the scope.
   * @param {string} scopeId - The scope identifier for policy checks.
   */
  constructor(network, policy, scopeId) {
    this.#network = network;
    this.#policy = policy;
    this.#scopeId = scopeId;
  }

  /**
   * Check a capability against the policy engine and throw if denied.
   *
   * @param {string} capability - The required capability tag.
   * @param {string} address - The target address (for policy context).
   * @throws {PolicyDeniedError} If the scope does not allow the capability.
   * @private
   */
  async #check(capability, address) {
    const result = await this.#policy.check(this.#scopeId, { capability, address });
    if (result !== 'allow') {
      throw new PolicyDeniedError(capability, address);
    }
  }

  /**
   * Open a stream connection, requiring {@link CAPABILITY.LOOPBACK} for loopback
   * schemes or {@link CAPABILITY.TCP_CONNECT} for others.
   *
   * @param {string} address - Full address (e.g. `"mem://localhost:8080"`).
   * @returns {Promise<import('./stream-socket.mjs').StreamSocket>} A connected stream socket.
   * @throws {PolicyDeniedError} If the scope lacks the required capability.
   * @throws {UnknownSchemeError} If the address scheme has no registered backend.
   * @throws {ConnectionRefusedError} If the target refuses the connection.
   */
  async connect(address) {
    const parsed = parseAddress(address);
    const cap = parsed.scheme === 'mem' || parsed.scheme === 'loop'
      ? CAPABILITY.LOOPBACK : CAPABILITY.TCP_CONNECT;
    await this.#check(cap, address);
    return this.#network.connect(address);
  }

  /**
   * Start listening, requiring {@link CAPABILITY.LOOPBACK} for loopback schemes
   * or {@link CAPABILITY.TCP_LISTEN} for others.
   *
   * @param {string} address - Full address (e.g. `"mem://localhost:8080"`).
   * @returns {Promise<import('./listener.mjs').Listener>} A bound listener.
   * @throws {PolicyDeniedError} If the scope lacks the required capability.
   * @throws {UnknownSchemeError} If the address scheme has no registered backend.
   * @throws {AddressInUseError} If the port is already in use.
   */
  async listen(address) {
    const parsed = parseAddress(address);
    const cap = parsed.scheme === 'mem' || parsed.scheme === 'loop'
      ? CAPABILITY.LOOPBACK : CAPABILITY.TCP_LISTEN;
    await this.#check(cap, address);
    return this.#network.listen(address);
  }

  /**
   * Send a datagram, requiring {@link CAPABILITY.LOOPBACK} for loopback schemes
   * or {@link CAPABILITY.UDP_SEND} for others.
   *
   * @param {string} address - Full address (e.g. `"mem://localhost:5353"`).
   * @param {Uint8Array} data - The datagram payload.
   * @returns {Promise<void>}
   * @throws {PolicyDeniedError} If the scope lacks the required capability.
   * @throws {UnknownSchemeError} If the address scheme has no registered backend.
   */
  async sendDatagram(address, data) {
    const parsed = parseAddress(address);
    const cap = parsed.scheme === 'mem' || parsed.scheme === 'loop'
      ? CAPABILITY.LOOPBACK : CAPABILITY.UDP_SEND;
    await this.#check(cap, address);
    return this.#network.sendDatagram(address, data);
  }

  /**
   * Bind a datagram socket, requiring {@link CAPABILITY.LOOPBACK} for loopback
   * schemes or {@link CAPABILITY.UDP_BIND} for others.
   *
   * @param {string} address - Full address (e.g. `"mem://localhost:0"`).
   * @returns {Promise<import('./datagram-socket.mjs').DatagramSocket>} A bound datagram socket.
   * @throws {PolicyDeniedError} If the scope lacks the required capability.
   * @throws {UnknownSchemeError} If the address scheme has no registered backend.
   * @throws {AddressInUseError} If the port is already in use.
   */
  async bindDatagram(address) {
    const parsed = parseAddress(address);
    const cap = parsed.scheme === 'mem' || parsed.scheme === 'loop'
      ? CAPABILITY.LOOPBACK : CAPABILITY.UDP_BIND;
    await this.#check(cap, address);
    return this.#network.bindDatagram(address);
  }

  /**
   * Resolve a hostname, requiring {@link CAPABILITY.DNS_RESOLVE}.
   *
   * @param {string} name - The hostname to resolve.
   * @param {string} [type='A'] - DNS record type.
   * @returns {Promise<string[]>} Resolved address strings.
   * @throws {PolicyDeniedError} If the scope lacks the `dns:resolve` capability.
   */
  async resolve(name, type = 'A') {
    await this.#check(CAPABILITY.DNS_RESOLVE, name);
    return this.#network.resolve(name, type);
  }
}
