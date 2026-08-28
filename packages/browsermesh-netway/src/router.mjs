/**
 * Router — address parsing and scheme-to-backend routing.
 *
 * The router maintains a map from URI scheme strings (e.g. `'mem'`, `'tcp'`) to
 * {@link Backend} instances. Given a full address like `"mem://localhost:8080"`,
 * {@link Router#resolve} parses the address and returns the matching backend.
 *
 * Also exports the standalone {@link parseAddress} function for parsing
 * `"scheme://host:port"` strings into their component parts.
 *
 * @module router
 */

import { UnknownSchemeError } from './errors.mjs';

/**
 * Maps URI schemes to network backends and resolves addresses.
 */
export class Router {
  #routes = new Map();

  /**
   * Register a backend for a URI scheme. If a backend is already registered for
   * the same scheme, it is replaced.
   *
   * @param {string} scheme - The URI scheme to register (e.g. `'mem'`, `'loop'`, `'tcp'`, `'udp'`).
   * @param {import('./backend.mjs').Backend} backend - The backend that handles
   *   connections for this scheme.
   */
  addRoute(scheme, backend) {
    this.#routes.set(scheme, backend);
  }

  /**
   * Parse an address and look up the backend for its scheme.
   *
   * @param {string} address - Full address string (e.g. `"mem://localhost:8080"`,
   *   `"tcp://example.com:443"`).
   * @returns {{ backend: import('./backend.mjs').Backend, parsed: { scheme: string, host: string, port: number } }}
   *   An object containing the resolved backend and the parsed address components.
   * @throws {UnknownSchemeError} If no backend is registered for the address's scheme.
   * @throws {Error} If the address string is malformed (no `://` separator).
   */
  resolve(address) {
    const parsed = parseAddress(address);
    const backend = this.#routes.get(parsed.scheme);
    if (!backend) throw new UnknownSchemeError(parsed.scheme);
    return { backend, parsed };
  }

  /**
   * Check whether a backend has been registered for the given scheme.
   *
   * @param {string} scheme - The URI scheme to check.
   * @returns {boolean} `true` if a backend is registered for the scheme.
   */
  hasScheme(scheme) {
    return this.#routes.has(scheme);
  }

  /** An array of all registered URI scheme strings. */
  get schemes() {
    return [...this.#routes.keys()];
  }
}

/**
 * Parse a network address string into its component parts.
 *
 * Supported formats:
 * - `"scheme://host:port"` — standard form (e.g. `"tcp://example.com:443"`)
 * - `"scheme://[ipv6]:port"` — IPv6 with bracket notation
 * - `"scheme://host"` — port defaults to `0` when omitted
 *
 * @param {string} address - The address string to parse.
 * @returns {{ scheme: string, host: string, port: number }} Parsed components.
 *   `port` is `0` when omitted or unparseable.
 * @throws {Error} If the address does not contain a `://` scheme separator.
 * @throws {Error} If an IPv6 address is missing the closing bracket.
 */
export function parseAddress(address) {
  const schemeEnd = address.indexOf('://');
  if (schemeEnd < 0) throw new Error(`Invalid address (no scheme): ${address}`);

  const scheme = address.slice(0, schemeEnd);
  const rest = address.slice(schemeEnd + 3);

  let host, port;

  if (rest.startsWith('[')) {
    // IPv6: [host]:port
    const bracketEnd = rest.indexOf(']');
    if (bracketEnd < 0) throw new Error(`Invalid IPv6 address: ${address}`);
    host = rest.slice(1, bracketEnd);
    const afterBracket = rest.slice(bracketEnd + 1);
    port = afterBracket.startsWith(':') ? parseInt(afterBracket.slice(1), 10) : 0;
  } else {
    const colonIdx = rest.lastIndexOf(':');
    if (colonIdx < 0) {
      host = rest;
      port = 0;
    } else {
      host = rest.slice(0, colonIdx);
      port = parseInt(rest.slice(colonIdx + 1), 10);
    }
  }

  if (isNaN(port)) port = 0;

  return { scheme, host, port };
}
