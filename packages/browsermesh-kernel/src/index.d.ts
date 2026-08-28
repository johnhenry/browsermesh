/**
 * kernel — Capability-secure browser microkernel.
 *
 * Provides resource handles, ByteStreams, IPC, service mesh, structured
 * tracing, chaos engineering, and tenant isolation — all with zero npm
 * dependencies, pure ES modules.
 *
 * @module kernel
 */

// ── Constants ────────────────────────────────────────────────────────

/** Default configuration values used across the kernel. */
export declare const KERNEL_DEFAULTS: Readonly<{
  /** Maximum entries in a ResourceTable. */
  MAX_RESOURCE_TABLE_SIZE: 4096;
  /** Default highWaterMark for ByteStream pipes. */
  DEFAULT_STREAM_BUFFER_SIZE: 1024;
  /** Default ring buffer size for Tracer events. */
  DEFAULT_TRACER_CAPACITY: 1024;
  /** Default ring buffer size for Logger entries. */
  DEFAULT_LOGGER_CAPACITY: 1024;
}>;

/** Capability tags for tenant access control. */
export declare const KERNEL_CAP: Readonly<{
  /** Access to networking subsystems. */
  NET: 'net';
  /** Access to filesystem operations. */
  FS: 'fs';
  /** Access to clock/time primitives. */
  CLOCK: 'clock';
  /** Access to random number generation. */
  RNG: 'rng';
  /** Access to inter-process communication. */
  IPC: 'ipc';
  /** Access to standard I/O streams. */
  STDIO: 'stdio';
  /** Access to the tracing subsystem. */
  TRACE: 'trace';
  /** Access to chaos engineering controls. */
  CHAOS: 'chaos';
  /** Access to environment variables. */
  ENV: 'env';
  /** Access to signal handling. */
  SIGNAL: 'signal';
  /** Access to mesh networking and P2P operations. */
  MESH: 'mesh';
  /** Access to payment channels and credit ledgers. */
  PAYMENT: 'payment';
  /** Access to voting and consensus protocols. */
  CONSENSUS: 'consensus';
  /** Wildcard granting all capabilities. */
  ALL: '*';
}>;

/** Union of all valid KERNEL_CAP values. */
export type KernelCapTag =
  | 'net' | 'fs' | 'clock' | 'rng' | 'ipc'
  | 'stdio' | 'trace' | 'chaos' | 'env' | 'signal'
  | 'mesh' | 'payment' | 'consensus' | '*';

/** Machine-readable error codes used by kernel error classes. */
export declare const KERNEL_ERROR: Readonly<{
  /** Resource handle not found in table. */
  ENOHANDLE: 'ENOHANDLE';
  /** Resource handle exists but type mismatch. */
  EHANDLETYPE: 'EHANDLETYPE';
  /** Resource table at maximum capacity. */
  ETABLEFULL: 'ETABLEFULL';
  /** Operation on a closed ByteStream. */
  ESTREAMCLOSED: 'ESTREAMCLOSED';
  /** Capability not granted to tenant. */
  ECAPDENIED: 'ECAPDENIED';
  /** Name or resource already registered. */
  EALREADY: 'EALREADY';
  /** Named resource not found. */
  ENOTFOUND: 'ENOTFOUND';
  /** Operation interrupted by signal. */
  ESIGNAL: 'ESIGNAL';
}>;

/** Union of all valid KERNEL_ERROR codes. */
export type KernelErrorCode =
  | 'ENOHANDLE' | 'EHANDLETYPE' | 'ETABLEFULL' | 'ESTREAMCLOSED'
  | 'ECAPDENIED' | 'EALREADY' | 'ENOTFOUND' | 'ESIGNAL';

// ── Errors ───────────────────────────────────────────────────────────

/** Base error class for all kernel errors. */
export declare class KernelError extends Error {
  /** Machine-readable error code. */
  readonly code: KernelErrorCode;
  constructor(message: string, code: string);
}

/** Thrown when a resource handle is not found in the ResourceTable. */
export declare class HandleNotFoundError extends KernelError {
  /** The handle that was not found. */
  readonly handle: string;
  readonly code: 'ENOHANDLE';
  constructor(handle: string);
}

/** Thrown when a resource handle exists but its type does not match the expected type. */
export declare class HandleTypeMismatchError extends KernelError {
  /** The handle that was accessed. */
  readonly handle: string;
  /** The expected resource type. */
  readonly expected: string;
  /** The actual resource type. */
  readonly actual: string;
  readonly code: 'EHANDLETYPE';
  constructor(handle: string, expected: string, actual: string);
}

/** Thrown when the ResourceTable has reached its maximum capacity. */
export declare class TableFullError extends KernelError {
  /** The table's maximum capacity. */
  readonly maxSize: number;
  readonly code: 'ETABLEFULL';
  constructor(maxSize: number);
}

/** Thrown when attempting to operate on a closed ByteStream. */
export declare class StreamClosedError extends KernelError {
  readonly code: 'ESTREAMCLOSED';
  constructor();
}

/** Thrown when a tenant lacks the required capability for an operation. */
export declare class CapabilityDeniedError extends KernelError {
  /** The capability that was required but not granted. */
  readonly capability: string;
  readonly code: 'ECAPDENIED';
  constructor(capability: string);
}

/** Thrown when attempting to register a name or resource that already exists. */
export declare class AlreadyRegisteredError extends KernelError {
  /** The name that was already registered. */
  readonly identifier: string;
  readonly code: 'EALREADY';
  constructor(identifier: string);
}

/** Thrown when a named resource is not found in a registry or lookup. */
export declare class NotFoundError extends KernelError {
  /** The name that was not found. */
  readonly identifier: string;
  readonly code: 'ENOTFOUND';
  constructor(identifier: string);
}

// ── ResourceTable ────────────────────────────────────────────────────

/** An entry stored in the ResourceTable. */
export interface ResourceEntry {
  type: string;
  value: unknown;
  owner: string;
}

/** Options for the ResourceTable constructor. */
export interface ResourceTableOptions {
  /** Maximum number of entries. Defaults to 4096. */
  maxSize?: number;
}

/** A bounded, handle-keyed resource table with ownership tracking. */
export declare class ResourceTable {
  constructor(opts?: ResourceTableOptions);

  /**
   * Allocate a new handle for a resource.
   * @returns The allocated handle (e.g. `'res_1'`).
   * @throws {TableFullError} If the table is at maximum capacity.
   */
  allocate(type: string, value: unknown, owner: string): string;

  /**
   * Get a resource entry by handle.
   * @throws {HandleNotFoundError} If the handle does not exist.
   */
  get(handle: string): ResourceEntry;

  /**
   * Get a resource value by handle, verifying the expected type.
   * @throws {HandleNotFoundError} If the handle does not exist.
   * @throws {HandleTypeMismatchError} If the resource type does not match.
   */
  getTyped(handle: string, type: string): unknown;

  /**
   * Transfer ownership of a resource to a new owner.
   * @throws {HandleNotFoundError} If the handle does not exist.
   */
  transfer(handle: string, newOwner: string): void;

  /**
   * Drop (remove) a resource from the table.
   * @returns The resource value that was removed.
   * @throws {HandleNotFoundError} If the handle does not exist.
   */
  drop(handle: string): unknown;

  /** Check whether a handle exists in the table. */
  has(handle: string): boolean;

  /** List all handles owned by a given owner. */
  listByOwner(owner: string): string[];

  /** List all handles of a given type. */
  listByType(type: string): string[];

  /** Current number of entries. */
  readonly size: number;

  /** Remove all entries from the table. */
  clear(): void;
}

// ── ByteStream ───────────────────────────────────────────────────────

/** Symbol used to tag objects as ByteStream-compliant. */
export declare const BYTE_STREAM: unique symbol;

/** Duck-typed ByteStream protocol interface. */
export interface ByteStream {
  [BYTE_STREAM]: true;
  read(): Promise<unknown | null>;
  write(data: unknown): Promise<void>;
  close(): Promise<void>;
  readonly closed: boolean;
}

/** A transform applied to ByteStream data via compose(). */
export interface ByteStreamTransform {
  transform(chunk: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/** Options for createPipe(). */
export interface CreatePipeOptions {
  /** Maximum queue depth. Defaults to 1024. */
  highWaterMark?: number;
}

/**
 * Check whether an object conforms to the ByteStream protocol.
 * A ByteStream must have `read`, `write`, and `close` methods.
 */
export declare function isByteStream(obj: unknown): obj is ByteStream;

/**
 * Tag an object with the ByteStream symbol. Idempotent.
 */
export declare function asByteStream<T extends { read: Function; write: Function; close: Function }>(obj: T): T & { [BYTE_STREAM]: true };

/**
 * Create an in-memory pipe returning `[reader, writer]` ByteStreams.
 * Data written to `writer` can be read from `reader`.
 */
export declare function createPipe(opts?: CreatePipeOptions): [ByteStream, ByteStream];

/**
 * Pipe all data from a source ByteStream to a destination ByteStream.
 * Reads from src until null (EOF), writes each chunk to dst.
 */
export declare function pipe(src: ByteStream, dst: ByteStream): Promise<void>;

/**
 * Create a sink ByteStream that discards all writes and returns null on read.
 */
export declare function devNull(): ByteStream;

/**
 * Compose one or more transforms onto a ByteStream, returning a new
 * ByteStream that applies the transforms in order on read and in
 * reverse order on write.
 */
export declare function compose(stream: ByteStream, ...transforms: ByteStreamTransform[]): ByteStream;

// ── Clock ────────────────────────────────────────────────────────────

/** Options for the Clock constructor. */
export interface ClockOptions {
  /** Monotonic time source (ms). */
  monoFn?: () => number;
  /** Wall-clock time source (ms since epoch). */
  wallFn?: () => number;
  /** Async sleep implementation. */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Clock providing monotonic and wall-clock time plus async sleep. */
export declare class Clock {
  constructor(opts?: ClockOptions);

  /** Get the current monotonic time in milliseconds. */
  nowMonotonic(): number;

  /** Get the current wall-clock time in milliseconds since the Unix epoch. */
  nowWall(): number;

  /** Sleep for the given number of milliseconds. */
  sleep(ms: number): Promise<void>;

  /**
   * Create a fixed (deterministic) clock for testing.
   * The clock always returns the same values unless manually advanced.
   */
  static fixed(mono: number, wall: number): Clock;
}

// ── RNG ──────────────────────────────────────────────────────────────

/** Options for the RNG constructor. */
export interface RNGOptions {
  /** Custom byte source. */
  getFn?: (n: number) => Uint8Array;
}

/** Random number generator with crypto and seeded modes. */
export declare class RNG {
  constructor(opts?: RNGOptions);

  /** Get `n` random bytes. */
  get(n: number): Uint8Array;

  /**
   * Create a deterministic seeded RNG using xorshift128+.
   * The same seed always produces the same sequence of bytes.
   */
  static seeded(seed: number): RNG;
}

// ── Capabilities ─────────────────────────────────────────────────────

/** Frozen capabilities object returned by buildCaps(). */
export interface Caps {
  readonly clock?: Clock;
  readonly rng?: RNG;
  readonly net?: true;
  readonly fs?: true;
  readonly ipc?: ServiceRegistry;
  readonly stdio?: true;
  readonly trace?: Tracer;
  readonly chaos?: ChaosEngine;
  readonly env?: true;
  readonly signal?: true;
  readonly _granted: readonly string[];
}

/**
 * Build a frozen capabilities object from granted capability tags.
 * Each granted tag maps to the corresponding kernel subsystem reference.
 */
export declare function buildCaps(kernel: Kernel, grantedCaps: string[]): Readonly<Caps>;

/**
 * Require that a capability tag is present in a caps object.
 * @throws {CapabilityDeniedError} If the capability is not granted.
 */
export declare function requireCap(caps: Caps, capTag: string): void;

/** Builder class for constructing capabilities (alternative to buildCaps). */
export declare class CapsBuilder {
  /**
   * Build capabilities from kernel and granted tags.
   */
  build(kernel: Kernel, grantedCaps: string[]): Readonly<Caps>;
}

// ── MessagePort / IPC ────────────────────────────────────────────────

/** Message handler callback type. */
export type MessageHandler = (msg: unknown, transfers?: unknown[]) => void;

/**
 * A message endpoint. Part of a channel pair created by createChannel().
 * Posting to one port delivers to the peer's listeners in FIFO order.
 */
export declare class KernelMessagePort {
  /**
   * Post a structured message. Delivered to the peer port's listeners.
   * @throws {StreamClosedError} If this port has been closed.
   */
  post(msg: unknown, transfers?: unknown[]): void;

  /**
   * Register a callback to receive messages.
   * @returns Unsubscribe function.
   */
  onMessage(cb: MessageHandler): () => void;

  /** Close the port. Subsequent post() calls throw StreamClosedError. */
  close(): void;

  /** Whether this port has been closed. */
  readonly closed: boolean;
}

/**
 * Create a connected pair of KernelMessagePorts.
 * Posting to portA delivers to portB's listeners, and vice versa.
 */
export declare function createChannel(): [KernelMessagePort, KernelMessagePort];

// ── ServiceRegistry ──────────────────────────────────────────────────

/** An entry in the ServiceRegistry. */
export interface ServiceEntry {
  name: string;
  listener: unknown;
  metadata: Record<string, unknown>;
  owner: string | null;
}

/** Options for ServiceRegistry.register(). */
export interface ServiceRegisterOptions {
  /** Arbitrary metadata about the service. */
  metadata?: Record<string, unknown>;
  /** Owner identifier. */
  owner?: string;
}

/** Registry for named services with lifecycle event callbacks. */
export declare class ServiceRegistry {
  /**
   * Register a named service.
   * @throws {AlreadyRegisteredError} If the name is already registered.
   */
  register(name: string, listener: unknown, opts?: ServiceRegisterOptions): void;

  /**
   * Unregister a named service.
   * @throws {NotFoundError} If the name is not registered.
   */
  unregister(name: string): void;

  /**
   * Look up a service by name. If not found locally, calls onLookupMiss hooks.
   * @throws {NotFoundError} If the service is not found.
   */
  lookup(name: string): Promise<ServiceEntry>;

  /** Check whether a service is registered. */
  has(name: string): boolean;

  /** List all registered service names. */
  list(): string[];

  /**
   * Register a callback for service registration events.
   * @returns Unsubscribe function.
   */
  onRegister(cb: (entry: ServiceEntry) => void): () => void;

  /**
   * Register a callback for service unregistration events.
   * @returns Unsubscribe function.
   */
  onUnregister(cb: (entry: ServiceEntry) => void): () => void;

  /**
   * Register a hook called when lookup() misses locally.
   * Hook receives the service name and may return a service entry or null.
   * @returns Unsubscribe function.
   */
  onLookupMiss(cb: (name: string) => Promise<ServiceEntry | null>): () => void;

  /**
   * Register a remote service entry (for distributed service awareness).
   * @throws {AlreadyRegisteredError} If the name is already registered.
   */
  registerRemote(name: string, nodeId: string, metadata?: Record<string, unknown>): void;

  /** Remove all registered services and callbacks. */
  clear(): void;
}

// ── Tracer ───────────────────────────────────────────────────────────

/** A stamped trace event. */
export interface TraceEvent {
  id: number;
  timestamp: number;
  type: string;
  [key: string]: unknown;
}

/** Options for the Tracer constructor. */
export interface TracerOptions {
  /** Maximum events in the ring buffer. Defaults to 1024. */
  capacity?: number;
  /** Clock instance with nowMonotonic(). Falls back to performance.now(). */
  clock?: Clock;
}

/** Structured event tracer with ring buffer storage and async iteration. */
export declare class Tracer {
  constructor(opts?: TracerOptions);

  /** Emit a trace event. The event is auto-stamped with `id` and `timestamp`. */
  emit(event: { type: string; [key: string]: unknown }): void;

  /**
   * Get an AsyncIterable of trace events. Each consumer gets an independent
   * iterator that yields events as they are emitted. Does not replay past events.
   */
  events(): AsyncIterable<TraceEvent>;

  /** Get a snapshot of all currently buffered events. */
  snapshot(): TraceEvent[];

  /** Clear all buffered events. */
  clear(): void;
}

// ── Logger ───────────────────────────────────────────────────────────

/** Log level constants. */
export declare const LOG_LEVEL: Readonly<{
  DEBUG: 0;
  INFO: 1;
  WARN: 2;
  ERROR: 3;
}>;

/** Union of LOG_LEVEL numeric values. */
export type LogLevelValue = 0 | 1 | 2 | 3;

/** A buffered log entry. */
export interface LogEntry {
  level: LogLevelValue;
  module: string;
  message: string;
  data: Record<string, unknown> | null;
  timestamp: number;
}

/** A scoped logger returned by Logger.forModule(). */
export interface ModuleLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Options for the Logger constructor. */
export interface LoggerOptions {
  /** Maximum log entries in buffer. Defaults to 1024. */
  capacity?: number;
  /** Optional Tracer to pipe log entries to. */
  tracer?: Tracer;
}

/** Options for Logger.entries() and Logger.snapshot(). */
export interface LogFilterOptions {
  /** Filter by module name. */
  module?: string;
  /** Minimum log level (LOG_LEVEL constant). */
  minLevel?: LogLevelValue;
}

/** Structured logger with per-module tagging and async iteration. */
export declare class Logger {
  constructor(opts?: LoggerOptions);

  /** Log a debug message. */
  debug(module: string, message: string, data?: Record<string, unknown>): void;

  /** Log an info message. */
  info(module: string, message: string, data?: Record<string, unknown>): void;

  /** Log a warning message. */
  warn(module: string, message: string, data?: Record<string, unknown>): void;

  /** Log an error message. */
  error(module: string, message: string, data?: Record<string, unknown>): void;

  /** Create a scoped logger for a specific module. */
  forModule(name: string): ModuleLogger;

  /** Get an AsyncIterable of log entries, optionally filtered. */
  entries(opts?: LogFilterOptions): AsyncIterable<LogEntry>;

  /** Get a snapshot of all currently buffered entries. */
  snapshot(opts?: LogFilterOptions): LogEntry[];
}

// ── ChaosEngine ──────────────────────────────────────────────────────

/** Configuration for the ChaosEngine. */
export interface ChaosConfig {
  /** Added latency in ms. Defaults to 0. */
  latencyMs?: number;
  /** Drop probability (0-1). Defaults to 0. */
  dropRate?: number;
  /** Disconnect probability (0-1). Defaults to 0. */
  disconnectRate?: number;
  /** Addresses to partition. Defaults to []. */
  partitionTargets?: string[];
}

/** Options for the ChaosEngine constructor. */
export interface ChaosEngineOptions {
  /** RNG instance for deterministic fault patterns. */
  rng?: RNG;
  /** Clock instance for delay implementation. */
  clock?: Clock;
}

/** Fault injection engine with global and per-scope configuration. */
export declare class ChaosEngine {
  constructor(opts?: ChaosEngineOptions);

  /** Enable the chaos engine. */
  enable(): void;

  /** Disable the chaos engine. */
  disable(): void;

  /** Whether the engine is enabled. */
  readonly enabled: boolean;

  /** Configure global fault injection defaults. */
  configure(config: ChaosConfig): void;

  /** Configure fault injection for a specific scope (overrides global). */
  configureScope(scopeId: string, config: ChaosConfig): void;

  /** Remove scope-specific configuration, falling back to global defaults. */
  removeScopeConfig(scopeId: string): void;

  /** Maybe inject latency delay. */
  maybeDelay(scopeId?: string): Promise<void>;

  /** Check whether a packet/message should be dropped. */
  shouldDrop(scopeId?: string): boolean;

  /** Check whether a connection should be forcibly disconnected. */
  shouldDisconnect(scopeId?: string): boolean;

  /** Check whether an address is partitioned (unreachable). */
  isPartitioned(addr: string, scopeId?: string): boolean;
}

// ── Environment ──────────────────────────────────────────────────────

/** Immutable environment variable store. */
export declare class Environment {
  constructor(vars?: Record<string, string>);

  /** Get an environment variable by key. */
  get(key: string): string | undefined;

  /** Check whether an environment variable exists. */
  has(key: string): boolean;

  /** Get a frozen copy of all environment variables. */
  all(): Readonly<Record<string, string>>;

  /** Number of environment variables. */
  readonly size: number;
}

// ── Signal ───────────────────────────────────────────────────────────

/** Signal name constants. */
export declare const SIGNAL: Readonly<{
  TERM: 'TERM';
  INT: 'INT';
  HUP: 'HUP';
}>;

/** Union of valid signal names. */
export type SignalName = 'TERM' | 'INT' | 'HUP';

/** Signal controller providing named signal dispatch and AbortSignal integration. */
export declare class SignalController {
  /**
   * Fire a named signal. All registered callbacks and AbortSignals
   * for this signal name are triggered.
   */
  signal(name: string): void;

  /**
   * Register a callback for a named signal.
   * @returns Unsubscribe function.
   */
  onSignal(name: string, cb: () => void): () => void;

  /** Get an AbortSignal that aborts when the named signal fires. */
  abortSignal(name: string): AbortSignal;

  /** Check whether a signal has been fired. */
  hasFired(name: string): boolean;

  /** Reset a signal so it can be fired again. */
  reset(name: string): void;

  /**
   * Get a composite AbortSignal that aborts on either TERM or INT.
   * Useful for graceful shutdown scenarios.
   */
  readonly shutdownSignal: AbortSignal;
}

// ── Stdio ────────────────────────────────────────────────────────────

/** Options for the Stdio constructor. */
export interface StdioOptions {
  /** Input ByteStream (defaults to devNull). */
  stdin?: ByteStream;
  /** Output ByteStream (defaults to devNull). */
  stdout?: ByteStream;
  /** Error ByteStream (defaults to devNull). */
  stderr?: ByteStream;
}

/** Standard I/O container wrapping ByteStream-compatible streams. */
export declare class Stdio {
  constructor(opts?: StdioOptions);

  /** Standard input stream. */
  readonly stdin: ByteStream;

  /** Standard output stream. */
  readonly stdout: ByteStream;

  /** Standard error stream. */
  readonly stderr: ByteStream;

  /** Write text to stdout (without trailing newline). */
  print(text: string): Promise<void>;

  /** Write text to stdout with a trailing newline. */
  println(text: string): Promise<void>;
}

// ── Kernel Facade ────────────────────────────────────────────────────

/** A tenant created by Kernel.createTenant(). */
export interface Tenant {
  /** Unique tenant identifier (e.g. `'tenant_1'`). */
  id: string;
  /** Frozen capabilities object scoped to the tenant's grants. */
  caps: Readonly<Caps>;
  /** Immutable per-tenant environment variables. */
  env: Environment;
  /** Per-tenant standard I/O streams. */
  stdio: Stdio;
  /** Per-tenant signal controller. */
  signals: SignalController;
}

/** Options for Kernel.createTenant(). */
export interface CreateTenantOptions {
  /** KERNEL_CAP tags to grant. Defaults to []. */
  capabilities?: string[];
  /** Tenant environment variables. Defaults to {}. */
  env?: Record<string, string>;
  /** Tenant stdio streams. */
  stdio?: StdioOptions;
}

/** Options for the Kernel constructor. */
export interface KernelOptions {
  /** Clock instance (defaults to real clock). */
  clock?: Clock;
  /** RNG instance (defaults to crypto RNG). */
  rng?: RNG;
  /** Options for Tracer constructor. */
  tracerOpts?: TracerOptions;
  /** Options for Logger constructor. */
  loggerOpts?: LoggerOptions;
  /** Options for ResourceTable constructor. */
  resourceOpts?: ResourceTableOptions;
}

/** The Kernel facade. Creates and wires all subsystems. */
export declare class Kernel {
  constructor(opts?: KernelOptions);

  /** The kernel's resource table. */
  readonly resources: ResourceTable;

  /** The kernel clock. */
  readonly clock: Clock;

  /** The kernel RNG. */
  readonly rng: RNG;

  /** The kernel tracer. */
  readonly tracer: Tracer;

  /** The kernel logger. */
  readonly log: Logger;

  /** The chaos engine. */
  readonly chaos: ChaosEngine;

  /** The service registry. */
  readonly services: ServiceRegistry;

  /** The signal controller. */
  readonly signals: SignalController;

  /**
   * Create a new tenant with scoped capabilities.
   */
  createTenant(opts?: CreateTenantOptions): Tenant;

  /** Destroy a tenant, dropping all owned resources. */
  destroyTenant(tenantId: string): void;

  /** Get a tenant by ID. */
  getTenant(tenantId: string): Tenant | undefined;

  /** List all tenant IDs. */
  listTenants(): string[];

  /** Close the kernel, destroying all tenants and clearing all subsystems. */
  close(): void;
}
