/**
 * Kernel error hierarchy.
 *
 * All kernel errors extend {@link KernelError}, which itself extends the native
 * `Error`. Each subclass carries a POSIX-style `.code` string (e.g. `'ENOHANDLE'`)
 * and additional contextual properties describing the failure.
 *
 * @module errors
 */

import { KERNEL_ERROR } from './constants.mjs';

/**
 * Base error class for all kernel errors.
 *
 * @property {string} code - Machine-readable error code.
 */
export class KernelError extends Error {
  /**
   * @param {string} message - Human-readable error description.
   * @param {string} code - Machine-readable error code.
   */
  constructor(message, code) {
    super(message);
    this.name = 'KernelError';
    this.code = code;
  }
}

/**
 * Thrown when a resource handle is not found in the ResourceTable.
 *
 * @property {string} handle - The handle that was not found.
 * @property {string} code - Always `'ENOHANDLE'`.
 */
export class HandleNotFoundError extends KernelError {
  /**
   * @param {string} handle - The handle that was not found.
   */
  constructor(handle) {
    super(`Handle not found: ${handle}`, KERNEL_ERROR.ENOHANDLE);
    this.name = 'HandleNotFoundError';
    this.handle = handle;
  }
}

/**
 * Thrown when a resource handle exists but its type does not match the expected type.
 *
 * @property {string} handle - The handle that was accessed.
 * @property {string} expected - The expected resource type.
 * @property {string} actual - The actual resource type.
 * @property {string} code - Always `'EHANDLETYPE'`.
 */
export class HandleTypeMismatchError extends KernelError {
  /**
   * @param {string} handle - The handle accessed.
   * @param {string} expected - Expected type.
   * @param {string} actual - Actual type.
   */
  constructor(handle, expected, actual) {
    super(`Handle type mismatch: ${handle} expected ${expected}, got ${actual}`, KERNEL_ERROR.EHANDLETYPE);
    this.name = 'HandleTypeMismatchError';
    this.handle = handle;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Thrown when the ResourceTable has reached its maximum capacity.
 *
 * @property {number} maxSize - The table's maximum capacity.
 * @property {string} code - Always `'ETABLEFULL'`.
 */
export class TableFullError extends KernelError {
  /**
   * @param {number} maxSize - Maximum table capacity.
   */
  constructor(maxSize) {
    super(`Resource table full: max ${maxSize} entries`, KERNEL_ERROR.ETABLEFULL);
    this.name = 'TableFullError';
    this.maxSize = maxSize;
  }
}

/**
 * Thrown when attempting to read from, write to, or operate on a closed ByteStream.
 *
 * @property {string} code - Always `'ESTREAMCLOSED'`.
 */
export class StreamClosedError extends KernelError {
  constructor() {
    super('Stream is closed', KERNEL_ERROR.ESTREAMCLOSED);
    this.name = 'StreamClosedError';
  }
}

/**
 * Thrown when a tenant lacks the required capability for an operation.
 *
 * @property {string} capability - The capability that was required but not granted.
 * @property {string} code - Always `'ECAPDENIED'`.
 */
export class CapabilityDeniedError extends KernelError {
  /**
   * @param {string} capability - The required capability tag.
   */
  constructor(capability) {
    super(`Capability denied: ${capability}`, KERNEL_ERROR.ECAPDENIED);
    this.name = 'CapabilityDeniedError';
    this.capability = capability;
  }
}

/**
 * Thrown when attempting to register a name or resource that already exists.
 *
 * @property {string} identifier - The name that was already registered.
 * @property {string} code - Always `'EALREADY'`.
 */
export class AlreadyRegisteredError extends KernelError {
  /**
   * @param {string} identifier - The duplicate name.
   */
  constructor(identifier) {
    super(`Already registered: ${identifier}`, KERNEL_ERROR.EALREADY);
    this.name = 'AlreadyRegisteredError';
    this.identifier = identifier;
  }
}

/**
 * Thrown when a named resource is not found in a registry or lookup.
 *
 * @property {string} identifier - The name that was not found.
 * @property {string} code - Always `'ENOTFOUND'`.
 */
export class NotFoundError extends KernelError {
  /**
   * @param {string} identifier - The name that was not found.
   */
  constructor(identifier) {
    super(`Not found: ${identifier}`, KERNEL_ERROR.ENOTFOUND);
    this.name = 'NotFoundError';
    this.identifier = identifier;
  }
}
