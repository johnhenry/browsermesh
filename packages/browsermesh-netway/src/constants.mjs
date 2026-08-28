/**
 * Netway constants — frozen defaults, error codes, and capability tag names.
 *
 * This module defines the shared configuration values, gateway error codes, and
 * capability strings used throughout the netway networking stack. All objects are
 * frozen to prevent runtime mutation.
 *
 * @module constants
 */

/**
 * Default configuration values used across the netway stack.
 *
 * @property {number} EPHEMERAL_PORT_START - First port in the ephemeral (auto-assign) range. Used by
 *   backends when a caller requests port 0.
 * @property {number} EPHEMERAL_PORT_END - Last port in the ephemeral range (inclusive).
 * @property {number} MAX_QUEUE_SIZE - Maximum number of operations that can be queued in an
 *   {@link OperationQueue} before throwing {@link QueueFullError}. Unit: count of operations.
 * @property {number} DRAIN_TIMEOUT_MS - Maximum time in milliseconds to wait for a single queued
 *   operation to complete during {@link OperationQueue#drain}. Exceeding this throws a timeout error.
 * @property {number} ACCEPT_QUEUE_SIZE - Maximum number of pending connections a {@link Listener}
 *   will buffer before silently dropping new arrivals (TCP backlog semantics).
 */
export const DEFAULTS = Object.freeze({
  EPHEMERAL_PORT_START: 49152,
  EPHEMERAL_PORT_END: 65535,
  MAX_QUEUE_SIZE: 256,
  DRAIN_TIMEOUT_MS: 10_000,
  ACCEPT_QUEUE_SIZE: 128,
});

/**
 * Numeric error codes returned by the gateway server in GATEWAY_FAIL messages.
 * Used by {@link GatewayBackend} to distinguish remote failure reasons.
 *
 * @property {number} CONNECTION_REFUSED - The remote host actively refused the connection (code 1).
 * @property {number} HOST_UNREACHABLE - The remote host could not be reached on the network (code 2).
 * @property {number} DNS_FAILED - DNS resolution failed for the requested hostname (code 3).
 * @property {number} POLICY_DENIED - The gateway's server-side policy blocked the request (code 4).
 * @property {number} TIMEOUT - The operation timed out before completing (code 5).
 * @property {number} CLOSED - The gateway connection was closed before the operation finished (code 6).
 * @property {number} QUEUE_FULL - The gateway's internal queue is full and cannot accept more work (code 7).
 */
export const GATEWAY_ERROR = Object.freeze({
  CONNECTION_REFUSED: 1,
  HOST_UNREACHABLE: 2,
  DNS_FAILED: 3,
  POLICY_DENIED: 4,
  TIMEOUT: 5,
  CLOSED: 6,
  QUEUE_FULL: 7,
});

/**
 * Capability tag strings used by the {@link PolicyEngine} to control which network
 * operations a scope is allowed to perform. Pass these to
 * {@link VirtualNetwork#scope} or {@link PolicyEngine#createScope} in the
 * `capabilities` array.
 *
 * @property {string} TCP_CONNECT - Permits outbound stream (TCP) connections (`'tcp:connect'`).
 * @property {string} TCP_LISTEN - Permits binding a listener for inbound stream connections (`'tcp:listen'`).
 * @property {string} UDP_SEND - Permits sending outbound datagrams (`'udp:send'`).
 * @property {string} UDP_BIND - Permits binding a datagram socket to receive inbound datagrams (`'udp:bind'`).
 * @property {string} DNS_RESOLVE - Permits DNS hostname resolution (`'dns:resolve'`).
 * @property {string} LOOPBACK - Permits all operations on loopback/in-memory backends (`'loopback'`).
 *   Automatically selected for `mem://` and `loop://` schemes.
 * @property {string} ALL - Wildcard that permits all capabilities (`'*'`).
 */
export const CAPABILITY = Object.freeze({
  TCP_CONNECT: 'tcp:connect',
  TCP_LISTEN: 'tcp:listen',
  UDP_SEND: 'udp:send',
  UDP_BIND: 'udp:bind',
  DNS_RESOLVE: 'dns:resolve',
  LOOPBACK: 'loopback',
  ALL: '*',
});
