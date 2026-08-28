/**
 * Kernel constants — frozen defaults, capability tags, and error codes.
 *
 * Defines shared configuration values, capability tags for tenant access
 * control, and machine-readable error codes used throughout the kernel.
 * All objects are frozen to prevent runtime mutation.
 *
 * @module constants
 */

/**
 * Default configuration values used across the kernel.
 *
 * @property {number} MAX_RESOURCE_TABLE_SIZE - Maximum entries in a ResourceTable.
 * @property {number} DEFAULT_STREAM_BUFFER_SIZE - Default highWaterMark for ByteStream pipes.
 * @property {number} DEFAULT_TRACER_CAPACITY - Default ring buffer size for Tracer events.
 * @property {number} DEFAULT_LOGGER_CAPACITY - Default ring buffer size for Logger entries.
 */
export const KERNEL_DEFAULTS = Object.freeze({
  MAX_RESOURCE_TABLE_SIZE: 4096,
  DEFAULT_STREAM_BUFFER_SIZE: 1024,
  DEFAULT_TRACER_CAPACITY: 1024,
  DEFAULT_LOGGER_CAPACITY: 1024,
});

/**
 * Capability tags for tenant access control.
 *
 * Each tag grants access to a kernel subsystem. Pass these to
 * {@link Kernel#createTenant} in the `capabilities` array.
 *
 * @property {string} NET - Access to networking subsystems (`'net'`).
 * @property {string} FS - Access to filesystem operations (`'fs'`).
 * @property {string} CLOCK - Access to clock/time primitives (`'clock'`).
 * @property {string} RNG - Access to random number generation (`'rng'`).
 * @property {string} IPC - Access to inter-process communication (`'ipc'`).
 * @property {string} STDIO - Access to standard I/O streams (`'stdio'`).
 * @property {string} TRACE - Access to the tracing subsystem (`'trace'`).
 * @property {string} CHAOS - Access to chaos engineering controls (`'chaos'`).
 * @property {string} ENV - Access to environment variables (`'env'`).
 * @property {string} SIGNAL - Access to signal handling (`'signal'`).
 * @property {string} MESH - Access to mesh networking and P2P operations (`'mesh'`).
 * @property {string} PAYMENT - Access to payment channels and credit ledgers (`'payment'`).
 * @property {string} CONSENSUS - Access to voting and consensus protocols (`'consensus'`).
 * @property {string} ALL - Wildcard granting all capabilities (`'*'`).
 */
export const KERNEL_CAP = Object.freeze({
  NET: 'net',
  FS: 'fs',
  CLOCK: 'clock',
  RNG: 'rng',
  IPC: 'ipc',
  STDIO: 'stdio',
  TRACE: 'trace',
  CHAOS: 'chaos',
  ENV: 'env',
  SIGNAL: 'signal',
  MESH: 'mesh',
  PAYMENT: 'payment',
  CONSENSUS: 'consensus',
  ALL: '*',
});

/**
 * Machine-readable error codes used by kernel error classes.
 *
 * @property {string} ENOHANDLE - Resource handle not found in table.
 * @property {string} EHANDLETYPE - Resource handle exists but type mismatch.
 * @property {string} ETABLEFULL - Resource table at maximum capacity.
 * @property {string} ESTREAMCLOSED - Operation on a closed ByteStream.
 * @property {string} ECAPDENIED - Capability not granted to tenant.
 * @property {string} EALREADY - Name or resource already registered.
 * @property {string} ENOTFOUND - Named resource not found.
 * @property {string} ESIGNAL - Operation interrupted by signal.
 */
export const KERNEL_ERROR = Object.freeze({
  ENOHANDLE: 'ENOHANDLE',
  EHANDLETYPE: 'EHANDLETYPE',
  ETABLEFULL: 'ETABLEFULL',
  ESTREAMCLOSED: 'ESTREAMCLOSED',
  ECAPDENIED: 'ECAPDENIED',
  EALREADY: 'EALREADY',
  ENOTFOUND: 'ENOTFOUND',
  ESIGNAL: 'ESIGNAL',
});
