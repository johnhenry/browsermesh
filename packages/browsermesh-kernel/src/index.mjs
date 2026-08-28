/**
 * kernel — Capability-secure browser microkernel.
 *
 * Provides resource handles, ByteStreams, IPC, service mesh, structured
 * tracing, chaos engineering, and tenant isolation — all with zero npm
 * dependencies, pure ES modules.
 *
 * ## Quick start
 *
 * ```js
 * import { Kernel, KERNEL_CAP } from 'browsermesh-kernel';
 *
 * const kernel = new Kernel();
 *
 * // Create a tenant with scoped capabilities
 * const tenant = kernel.createTenant({
 *   capabilities: [KERNEL_CAP.CLOCK, KERNEL_CAP.IPC, KERNEL_CAP.STDIO],
 *   env: { MODE: 'sandbox' },
 * });
 *
 * // Use kernel subsystems
 * const handle = kernel.resources.allocate('stream', myStream, tenant.id);
 * kernel.tracer.emit({ type: 'custom', tenant: tenant.id });
 *
 * // Clean up
 * kernel.destroyTenant(tenant.id);
 * kernel.close();
 * ```
 *
 * @module kernel
 */

// Constants + errors
export { KERNEL_DEFAULTS, KERNEL_CAP, KERNEL_ERROR } from './constants.mjs';
export {
  KernelError, HandleNotFoundError, HandleTypeMismatchError,
  TableFullError, StreamClosedError, CapabilityDeniedError,
  AlreadyRegisteredError, NotFoundError,
} from './errors.mjs';

// Resource management
export { ResourceTable } from './resource-table.mjs';

// ByteStream protocol
export { BYTE_STREAM, isByteStream, asByteStream, createPipe, pipe, devNull, compose } from './byte-stream.mjs';

// Clock + RNG
export { Clock } from './clock.mjs';
export { RNG } from './rng.mjs';

// Capabilities
export { buildCaps, requireCap, CapsBuilder } from './caps.mjs';

// IPC
export { KernelMessagePort, createChannel } from './message-port.mjs';
export { ServiceRegistry } from './service-registry.mjs';

// Observability
export { Tracer } from './tracer.mjs';
export { Logger, LOG_LEVEL } from './logger.mjs';

// Chaos engineering
export { ChaosEngine } from './chaos.mjs';

// Environment
export { Environment } from './env.mjs';

// Signals + Stdio
export { SIGNAL, SignalController } from './signal.mjs';
export { Stdio } from './stdio.mjs';

// Kernel facade
export { Kernel } from './kernel.mjs';
