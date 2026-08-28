/**
 * Netway error hierarchy.
 *
 * All netway errors extend {@link NetwayError}, which itself extends the native
 * `Error`. Each subclass carries a POSIX-style `.code` string (e.g. `'ECONNREFUSED'`)
 * and additional contextual properties describing the failure.
 *
 * @module errors
 */

/**
 * Base error class for all netway errors.
 *
 * Carries a machine-readable `.code` string alongside the human-readable message.
 * All other netway error classes extend this.
 *
 * @property {string} code - Machine-readable error code (e.g. `'ECONNREFUSED'`, `'EPOLICY'`).
 */
export class NetwayError extends Error {
  /**
   * @param {string} message - Human-readable error description.
   * @param {string} code - Machine-readable error code.
   */
  constructor(message, code) {
    super(message);
    this.name = 'NetwayError';
    this.code = code;
  }
}

/**
 * Thrown when a stream connection attempt is refused because no listener is bound
 * on the target address/port, or the remote gateway rejected the connection.
 *
 * @property {string} address - The address that refused the connection (e.g. `'loop://localhost:8080'`).
 * @property {string} code - Always `'ECONNREFUSED'`.
 */
export class ConnectionRefusedError extends NetwayError {
  /**
   * @param {string} address - The target address that refused the connection.
   */
  constructor(address) {
    super(`Connection refused: ${address}`, 'ECONNREFUSED');
    this.name = 'ConnectionRefusedError';
    this.address = address;
  }
}

/**
 * Thrown when a network operation is blocked by the {@link PolicyEngine} because
 * the scope does not hold the required capability.
 *
 * @property {string} capability - The capability tag that was denied (e.g. `'tcp:connect'`).
 * @property {string} address - The target address of the denied operation.
 * @property {string} code - Always `'EPOLICY'`.
 */
export class PolicyDeniedError extends NetwayError {
  /**
   * @param {string} capability - The capability that was required but not granted.
   * @param {string} address - The target address of the denied operation.
   */
  constructor(capability, address) {
    super(`Policy denied: ${capability} for ${address}`, 'EPOLICY');
    this.name = 'PolicyDeniedError';
    this.capability = capability;
    this.address = address;
  }
}

/**
 * Thrown when attempting to bind a listener or datagram socket to a port that is
 * already in use by another listener or socket in the same backend.
 *
 * @property {number} port - The port number that is already occupied.
 * @property {string} code - Always `'EADDRINUSE'`.
 */
export class AddressInUseError extends NetwayError {
  /**
   * @param {number} port - The port that is already bound.
   */
  constructor(port) {
    super(`Address already in use: port ${port}`, 'EADDRINUSE');
    this.name = 'AddressInUseError';
    this.port = port;
  }
}

/**
 * Thrown by {@link OperationQueue#enqueue} when the queue has reached its maximum
 * capacity and cannot accept additional operations.
 *
 * @property {string} code - Always `'EQUEUEFULL'`.
 */
export class QueueFullError extends NetwayError {
  constructor() {
    super('Operation queue is full', 'EQUEUEFULL');
    this.name = 'QueueFullError';
  }
}

/**
 * Thrown by {@link Router#resolve} when the address contains a URI scheme that
 * has no registered backend.
 *
 * @property {string} scheme - The unrecognized URI scheme (e.g. `'ftp'`).
 * @property {string} code - Always `'ENOROUTE'`.
 */
export class UnknownSchemeError extends NetwayError {
  /**
   * @param {string} scheme - The URI scheme that has no registered backend.
   */
  constructor(scheme) {
    super(`Unknown address scheme: ${scheme}`, 'ENOROUTE');
    this.name = 'UnknownSchemeError';
    this.scheme = scheme;
  }
}

/**
 * Thrown when attempting to write to or send through a socket that has already
 * been closed. Also thrown internally when operations are attempted on a closed
 * backend.
 *
 * @property {string} code - Always `'ECLOSED'`.
 */
export class SocketClosedError extends NetwayError {
  constructor() {
    super('Socket is closed', 'ECLOSED');
    this.name = 'SocketClosedError';
  }
}

/**
 * Thrown when a gateway operation (connect, listen, resolve, sendDatagram)
 * does not receive a response from the server within the configured timeout.
 *
 * @property {string} code - Always `'ETIMEDOUT'`.
 */
export class OperationTimeoutError extends NetwayError {
  constructor(operation) {
    super(`Gateway operation timed out: ${operation}`, 'ETIMEDOUT');
    this.name = 'OperationTimeoutError';
  }
}
