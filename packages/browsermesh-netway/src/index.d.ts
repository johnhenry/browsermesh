/**
 * netway — Virtual networking layer for browser environments.
 *
 * Provides TCP-like streams, UDP-like datagrams, DNS resolution, and
 * capability-based policy enforcement, all running in-memory or proxied through
 * a remote gateway server.
 *
 * @module netway
 */

// ---------------------------------------------------------------------------
// constants.mjs
// ---------------------------------------------------------------------------

/** Default configuration values used across the netway stack. */
export interface DefaultsConfig {
  /** First port in the ephemeral (auto-assign) range. */
  readonly EPHEMERAL_PORT_START: 49152;
  /** Last port in the ephemeral range (inclusive). */
  readonly EPHEMERAL_PORT_END: 65535;
  /** Maximum number of operations that can be queued in an OperationQueue. */
  readonly MAX_QUEUE_SIZE: 256;
  /** Maximum time in milliseconds to wait for a single queued operation during drain. */
  readonly DRAIN_TIMEOUT_MS: 10_000;
  /** Maximum number of pending connections a Listener will buffer. */
  readonly ACCEPT_QUEUE_SIZE: 128;
}

/** Frozen default configuration values. */
export const DEFAULTS: Readonly<DefaultsConfig>;

/** Numeric error codes returned by the gateway server in GATEWAY_FAIL messages. */
export interface GatewayErrorCodes {
  /** The remote host actively refused the connection (code 1). */
  readonly CONNECTION_REFUSED: 1;
  /** The remote host could not be reached on the network (code 2). */
  readonly HOST_UNREACHABLE: 2;
  /** DNS resolution failed for the requested hostname (code 3). */
  readonly DNS_FAILED: 3;
  /** The gateway's server-side policy blocked the request (code 4). */
  readonly POLICY_DENIED: 4;
  /** The operation timed out before completing (code 5). */
  readonly TIMEOUT: 5;
  /** The gateway connection was closed before the operation finished (code 6). */
  readonly CLOSED: 6;
  /** The gateway's internal queue is full (code 7). */
  readonly QUEUE_FULL: 7;
}

/** Frozen gateway error codes. */
export const GATEWAY_ERROR: Readonly<GatewayErrorCodes>;

/** Capability tag strings used by the PolicyEngine. */
export interface CapabilityTags {
  /** Permits outbound stream (TCP) connections. */
  readonly TCP_CONNECT: 'tcp:connect';
  /** Permits binding a listener for inbound stream connections. */
  readonly TCP_LISTEN: 'tcp:listen';
  /** Permits sending outbound datagrams. */
  readonly UDP_SEND: 'udp:send';
  /** Permits binding a datagram socket to receive inbound datagrams. */
  readonly UDP_BIND: 'udp:bind';
  /** Permits DNS hostname resolution. */
  readonly DNS_RESOLVE: 'dns:resolve';
  /** Permits all operations on loopback/in-memory backends. */
  readonly LOOPBACK: 'loopback';
  /** Wildcard that permits all capabilities. */
  readonly ALL: '*';
}

/** Frozen capability tag constants. */
export const CAPABILITY: Readonly<CapabilityTags>;

/** Union of all capability tag string values. */
export type CapabilityTag =
  | 'tcp:connect'
  | 'tcp:listen'
  | 'udp:send'
  | 'udp:bind'
  | 'dns:resolve'
  | 'loopback'
  | '*';

// ---------------------------------------------------------------------------
// errors.mjs
// ---------------------------------------------------------------------------

/** Base error class for all netway errors. */
export class NetwayError extends Error {
  /** Machine-readable error code (e.g. 'ECONNREFUSED', 'EPOLICY'). */
  readonly code: string;
  readonly name: string;

  /**
   * @param message - Human-readable error description.
   * @param code - Machine-readable error code.
   */
  constructor(message: string, code: string);
}

/** Thrown when a stream connection attempt is refused. */
export class ConnectionRefusedError extends NetwayError {
  /** The address that refused the connection. */
  readonly address: string;
  readonly code: 'ECONNREFUSED';

  /**
   * @param address - The target address that refused the connection.
   */
  constructor(address: string);
}

/** Thrown when a network operation is blocked by the PolicyEngine. */
export class PolicyDeniedError extends NetwayError {
  /** The capability tag that was denied. */
  readonly capability: string;
  /** The target address of the denied operation. */
  readonly address: string;
  readonly code: 'EPOLICY';

  /**
   * @param capability - The capability that was required but not granted.
   * @param address - The target address of the denied operation.
   */
  constructor(capability: string, address: string);
}

/** Thrown when attempting to bind to a port that is already in use. */
export class AddressInUseError extends NetwayError {
  /** The port number that is already occupied. */
  readonly port: number;
  readonly code: 'EADDRINUSE';

  /**
   * @param port - The port that is already bound.
   */
  constructor(port: number);
}

/** Thrown when the operation queue has reached its maximum capacity. */
export class QueueFullError extends NetwayError {
  readonly code: 'EQUEUEFULL';

  constructor();
}

/** Thrown when the address contains a URI scheme that has no registered backend. */
export class UnknownSchemeError extends NetwayError {
  /** The unrecognized URI scheme. */
  readonly scheme: string;
  readonly code: 'ENOROUTE';

  /**
   * @param scheme - The URI scheme that has no registered backend.
   */
  constructor(scheme: string);
}

/** Thrown when attempting to write to or send through a closed socket. */
export class SocketClosedError extends NetwayError {
  readonly code: 'ECLOSED';

  constructor();
}

/** Thrown when a gateway operation does not receive a response within the configured timeout. */
export class OperationTimeoutError extends NetwayError {
  readonly code: 'ETIMEDOUT';

  /**
   * @param operation - Description of the operation that timed out.
   */
  constructor(operation: string);
}

// ---------------------------------------------------------------------------
// queue.mjs
// ---------------------------------------------------------------------------

/** Options for constructing an OperationQueue. */
export interface OperationQueueOptions {
  /**
   * Maximum number of operations the queue will hold.
   * @default DEFAULTS.MAX_QUEUE_SIZE (256)
   */
  maxSize?: number;
  /**
   * Maximum time in milliseconds to wait for a single operation during drain.
   * @default DEFAULTS.DRAIN_TIMEOUT_MS (10000)
   */
  drainTimeoutMs?: number;
}

/** A bounded, FIFO operation queue with deferred execution. */
export class OperationQueue {
  constructor(opts?: OperationQueueOptions);

  /** The current number of operations in the queue. */
  readonly size: number;

  /** The maximum number of operations this queue can hold. */
  readonly maxSize: number;

  /**
   * Add an operation to the queue.
   *
   * @param operation - Arbitrary operation descriptor passed through to the executeFn during drain.
   * @returns Resolves with the executeFn result when drained.
   * @throws QueueFullError if the queue has reached its maximum capacity.
   */
  enqueue<T = any>(operation: any): Promise<T>;

  /**
   * Drain all queued operations by executing them sequentially (FIFO).
   *
   * @param executeFn - Async callback that receives each queued operation and returns a result.
   */
  drain(executeFn: (operation: any) => Promise<any>): Promise<void>;

  /**
   * Discard all queued operations. Each pending operation's promise
   * is rejected with a 'Queue cleared' error.
   */
  clear(): void;
}

// ---------------------------------------------------------------------------
// stream-socket.mjs
// ---------------------------------------------------------------------------

/** Options for creating a StreamSocket pair. */
export interface StreamSocketPairOptions {
  /**
   * Maximum queue depth per buffer before the socket is closed.
   * Set to 0 for unlimited (not recommended for production use).
   * @default 1024
   */
  highWaterMark?: number;
}

/**
 * A reliable, ordered, bidirectional byte stream socket (TCP-like).
 */
export class StreamSocket {
  /**
   * Read the next chunk of data from the stream.
   * Returns null when the socket is closed (EOF).
   */
  read(): Promise<Uint8Array | null>;

  /**
   * Write a chunk of data to the stream.
   *
   * @param data - The data to send.
   * @throws SocketClosedError if the socket has already been closed.
   */
  write(data: Uint8Array): Promise<void>;

  /**
   * Close the socket, shutting down both directions.
   * Calling close on an already-closed socket is a no-op.
   */
  close(): Promise<void>;

  /** Whether this socket has been closed. */
  readonly closed: boolean;

  /**
   * Create a connected pair of StreamSockets for in-memory communication.
   * Data written to one socket can be read from the other, and vice versa.
   *
   * @returns A two-element tuple [socketA, socketB].
   */
  static createPair(opts?: StreamSocketPairOptions): [StreamSocket, StreamSocket];
}

// ---------------------------------------------------------------------------
// datagram-socket.mjs
// ---------------------------------------------------------------------------

/** Options for constructing a DatagramSocket. */
export interface DatagramSocketOptions {
  /**
   * Backend-provided function that transmits a datagram to the given address.
   */
  sendFn: (address: string, data: Uint8Array) => Promise<void>;
  /** The local port this socket is bound to. */
  localPort: number;
}

/**
 * An unreliable, message-oriented datagram socket (UDP-like).
 */
export class DatagramSocket {
  constructor(opts: DatagramSocketOptions);

  /** The local port number this socket is bound to. */
  readonly localPort: number;

  /** Whether this socket has been closed. */
  readonly closed: boolean;

  /**
   * Send a datagram to the specified address.
   *
   * @param address - Target address in "host:port" format.
   * @param data - The datagram payload.
   * @throws SocketClosedError if the socket has already been closed.
   */
  send(address: string, data: Uint8Array): Promise<void>;

  /**
   * Register a callback to receive inbound datagrams.
   *
   * @param cb - Called with (fromAddress, data) for each inbound datagram.
   */
  onMessage(cb: (fromAddress: string, data: Uint8Array) => void): void;

  /**
   * Close the socket. Prevents further sends.
   * Calling close on an already-closed socket is a no-op.
   */
  close(): void;
}

// ---------------------------------------------------------------------------
// listener.mjs
// ---------------------------------------------------------------------------

/** Options for constructing a Listener. */
export interface ListenerOptions {
  /** The port this listener is bound to. */
  localPort: number;
  /**
   * Maximum number of pending connections to buffer.
   * @default DEFAULTS.ACCEPT_QUEUE_SIZE (128)
   */
  maxQueueSize?: number;
}

/**
 * A server-side listener that accepts incoming StreamSocket connections.
 */
export class Listener {
  constructor(opts: ListenerOptions);

  /** The local port number this listener is bound to. */
  readonly localPort: number;

  /** Whether this listener has been closed. */
  readonly closed: boolean;

  /**
   * Wait for and return the next incoming connection.
   * Returns null when the listener is closed.
   */
  accept(): Promise<StreamSocket | null>;

  /**
   * Close the listener. All pending accept() calls resolve with null.
   * Calling close on an already-closed listener is a no-op.
   */
  close(): void;
}

// ---------------------------------------------------------------------------
// policy.mjs
// ---------------------------------------------------------------------------

/** Describes a capability check request. */
export interface PolicyRequest {
  /** The required capability tag. */
  capability: string;
  /** The target address, for context in custom policy callbacks. */
  address?: string;
}

/** Return type of policy decisions. */
export type PolicyDecision = 'allow' | 'deny';

/**
 * Custom policy callback type.
 * Receives the request and capability set, returns an allow/deny decision.
 */
export type PolicyCallback = (
  request: PolicyRequest,
  capabilities: Set<string>,
) => PolicyDecision | Promise<PolicyDecision>;

/** Options for creating a policy scope. */
export interface PolicyScopeOptions {
  /**
   * Capability tags granted to this scope.
   * @default []
   */
  capabilities?: string[];
  /** Optional custom policy callback with final authority over allow/deny. */
  policy?: PolicyCallback;
}

/**
 * Manages named policy scopes and evaluates capability-based access decisions.
 */
export class PolicyEngine {
  /**
   * Create a new policy scope.
   *
   * @returns A unique scope identifier (e.g. 'scope_1').
   */
  createScope(opts?: PolicyScopeOptions): string;

  /**
   * Check whether a network operation is permitted within a scope.
   *
   * @param scopeId - The scope identifier.
   * @param request - Description of the operation being attempted.
   * @returns The access decision.
   */
  check(scopeId: string, request: PolicyRequest): Promise<PolicyDecision>;

  /**
   * Remove a previously created scope.
   *
   * @param scopeId - The scope identifier to remove.
   */
  removeScope(scopeId: string): void;
}

// ---------------------------------------------------------------------------
// router.mjs
// ---------------------------------------------------------------------------

/** Parsed address components. */
export interface ParsedAddress {
  /** The URI scheme (e.g. 'mem', 'tcp'). */
  scheme: string;
  /** The hostname or IP address. */
  host: string;
  /** The port number (0 when omitted or unparseable). */
  port: number;
}

/** Result of Router.resolve(). */
export interface ResolveResult {
  /** The backend that handles this scheme. */
  backend: Backend;
  /** The parsed address components. */
  parsed: ParsedAddress;
}

/**
 * Parse a network address string into its component parts.
 *
 * Supported formats:
 * - "scheme://host:port" (standard form)
 * - "scheme://[ipv6]:port" (IPv6 with bracket notation)
 * - "scheme://host" (port defaults to 0)
 *
 * @param address - The address string to parse.
 * @throws Error if the address does not contain a "://" scheme separator.
 * @throws Error if an IPv6 address is missing the closing bracket.
 */
export function parseAddress(address: string): ParsedAddress;

/**
 * Maps URI schemes to network backends and resolves addresses.
 */
export class Router {
  /**
   * Register a backend for a URI scheme.
   *
   * @param scheme - The URI scheme to register (e.g. 'mem', 'tcp').
   * @param backend - The backend that handles connections for this scheme.
   */
  addRoute(scheme: string, backend: Backend): void;

  /**
   * Parse an address and look up the backend for its scheme.
   *
   * @param address - Full address string (e.g. "mem://localhost:8080").
   * @throws UnknownSchemeError if no backend is registered for the scheme.
   * @throws Error if the address string is malformed.
   */
  resolve(address: string): ResolveResult;

  /**
   * Check whether a backend has been registered for the given scheme.
   */
  hasScheme(scheme: string): boolean;

  /** An array of all registered URI scheme strings. */
  readonly schemes: string[];
}

// ---------------------------------------------------------------------------
// backend.mjs
// ---------------------------------------------------------------------------

/**
 * Abstract base class for network backends.
 *
 * Subclasses implement the five core networking primitives:
 * stream connect, stream listen, datagram send, datagram bind, and DNS resolve.
 */
export class Backend {
  /**
   * Open a stream (TCP-like) connection to the given host and port.
   *
   * @param host - The target hostname or IP address.
   * @param port - The target port number.
   */
  connect(host: string, port: number): Promise<StreamSocket>;

  /**
   * Start listening for incoming stream connections on the given port.
   *
   * @param port - The port to listen on. Pass 0 for auto-assignment.
   */
  listen(port: number): Promise<Listener>;

  /**
   * Send a single datagram (UDP-like) to the given host and port.
   *
   * @param host - The target hostname or IP address.
   * @param port - The target port number.
   * @param data - The datagram payload.
   */
  sendDatagram(host: string, port: number, data: Uint8Array): Promise<void>;

  /**
   * Bind a datagram socket to receive incoming datagrams on the given port.
   *
   * @param port - The port to bind. Pass 0 for auto-assignment.
   */
  bindDatagram(port: number): Promise<DatagramSocket>;

  /**
   * Resolve a hostname to one or more addresses.
   *
   * @param name - The hostname to resolve.
   * @param type - DNS record type (e.g. 'A', 'AAAA').
   */
  resolve(name: string, type: string): Promise<string[]>;

  /**
   * Gracefully shut down the backend, closing all active sockets, listeners,
   * and releasing resources.
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// loopback-backend.mjs
// ---------------------------------------------------------------------------

/**
 * In-memory loopback backend. All traffic stays within the same JS runtime.
 * Registered by default in VirtualNetwork for the 'mem' and 'loop' schemes.
 */
export class LoopbackBackend extends Backend {
  /**
   * Open a stream connection to a local listener.
   *
   * @param host - Ignored in loopback (all hosts are local).
   * @param port - The port of the target listener.
   * @throws ConnectionRefusedError if no listener is bound on the given port.
   */
  connect(host: string, port: number): Promise<StreamSocket>;

  /**
   * Start listening for incoming stream connections on a local port.
   *
   * @param port - The port to listen on. Pass 0 for auto-assignment.
   * @throws AddressInUseError if the requested port is already occupied.
   */
  listen(port: number): Promise<Listener>;

  /**
   * Send a datagram to a locally bound datagram socket.
   * Silently dropped if no socket is bound (UDP semantics).
   *
   * @param host - Ignored in loopback.
   * @param port - The target port.
   * @param data - The datagram payload.
   */
  sendDatagram(host: string, port: number, data: Uint8Array): Promise<void>;

  /**
   * Bind a datagram socket to a local port.
   *
   * @param port - The port to bind. Pass 0 for auto-assignment.
   * @throws AddressInUseError if the requested port is already occupied.
   */
  bindDatagram(port: number): Promise<DatagramSocket>;

  /**
   * Resolve a hostname. Always returns ['127.0.0.1'] in loopback.
   */
  resolve(name: string, type: string): Promise<string[]>;

  /** Close all listeners and datagram sockets. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// gateway-backend.mjs
// ---------------------------------------------------------------------------

/** A wsh client interface as expected by GatewayBackend. */
export interface WshClient {
  /** Current connection state (e.g. 'authenticated'). */
  readonly state: string;
  /** Send a control message to the gateway server. */
  sendControl(msg: any): Promise<void>;
  /** Callback for inbound gateway messages. Assigned by GatewayBackend. */
  onGatewayMessage: ((msg: any) => void) | null;
}

/** Options for constructing a GatewayBackend. */
export interface GatewayBackendOptions {
  /** A wsh client instance for communicating with the gateway server. */
  wshClient?: WshClient;
  /** Configuration for the internal OperationQueue. */
  queueConfig?: OperationQueueOptions;
  /**
   * Timeout in milliseconds for gateway operations. Set to 0 to disable.
   * @default 30000
   */
  operationTimeoutMs?: number;
}

/**
 * A backend that proxies all networking through a remote wsh gateway server.
 */
export class GatewayBackend extends Backend {
  constructor(opts?: GatewayBackendOptions);

  /**
   * Whether the backend is currently connected to the gateway.
   * True when not closed and the wsh client is in the 'authenticated' state.
   */
  readonly connected: boolean;

  /**
   * Open a stream connection through the gateway.
   * If offline, the operation is queued.
   *
   * @param host - The remote hostname or IP.
   * @param port - The remote port number.
   * @throws ConnectionRefusedError if the remote end refuses.
   * @throws QueueFullError if offline and the queue is full.
   */
  connect(host: string, port: number): Promise<StreamSocket>;

  /**
   * Request the gateway to listen for incoming connections.
   * If offline, the operation is queued.
   *
   * @param port - The port to listen on. Pass 0 for server-assigned.
   * @throws NetwayError if the server rejects the listen request.
   * @throws QueueFullError if offline and the queue is full.
   */
  listen(port: number): Promise<Listener>;

  /**
   * Send a datagram through the gateway. If offline, the operation is queued.
   *
   * @param host - The target hostname or IP.
   * @param port - The target port number.
   * @param data - The datagram payload.
   * @throws ConnectionRefusedError if the gateway rejects the UDP open.
   * @throws QueueFullError if offline and the queue is full.
   */
  sendDatagram(host: string, port: number, data: Uint8Array): Promise<void>;

  /**
   * Resolve a hostname through the gateway's DNS. If offline, queued.
   *
   * @param name - The hostname to resolve.
   * @param type - DNS record type (e.g. 'A', 'AAAA').
   * @throws ConnectionRefusedError if the gateway reports a DNS failure.
   * @throws QueueFullError if offline and the queue is full.
   */
  resolve(name: string, type?: string): Promise<string[]>;

  /**
   * Drain all queued operations by executing them against the
   * now-connected gateway. Call after the wsh client reconnects.
   */
  drain(): Promise<void>;

  /**
   * Close the backend, clearing the queue and rejecting all pending operations.
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// service-backend.mjs
// ---------------------------------------------------------------------------

/**
 * Backend that routes connections to kernel services via ServiceRegistry.
 * Handles the 'svc' scheme (e.g. svc://echo).
 */
export class ServiceBackend extends Backend {
  /**
   * @param registry - A kernel ServiceRegistry instance.
   */
  constructor(registry: any);

  /**
   * Connect to a named service.
   *
   * @param host - Service name (e.g. 'echo' for svc://echo).
   * @param port - Ignored for service connections.
   * @throws ConnectionRefusedError if the service is not registered or has no listener.
   */
  connect(host: string, port?: number): Promise<StreamSocket>;
}

// ---------------------------------------------------------------------------
// chaos-backend-wrapper.mjs
// ---------------------------------------------------------------------------

/**
 * Wraps an inner Backend with ChaosEngine fault injection.
 * Interposes on connect() and sendDatagram() to inject configurable
 * latency, drops, disconnects, and partitions.
 */
export class ChaosBackendWrapper extends Backend {
  /**
   * @param inner - The wrapped backend.
   * @param chaos - A kernel ChaosEngine instance.
   * @param scopeId - Optional scope ID for per-scope chaos configuration.
   */
  constructor(inner: Backend, chaos: any, scopeId?: string);

  /**
   * Connect with fault injection: partition check, delay, drop check, then inner connect.
   *
   * @param host - The target hostname or IP.
   * @param port - The target port number.
   * @throws ConnectionRefusedError if partitioned or dropped.
   */
  connect(host: string, port: number): Promise<StreamSocket>;

  /** Listen -- delegates directly to inner (no fault injection). */
  listen(port: number): Promise<Listener>;

  /**
   * Send datagram with fault injection: drop check, delay, then inner send.
   * Silently dropped if chaos drops the packet.
   */
  sendDatagram(host: string, port: number, data: Uint8Array): Promise<void>;

  /** Bind datagram -- delegates directly to inner. */
  bindDatagram(port: number): Promise<DatagramSocket>;

  /** Resolve -- delegates directly to inner. */
  resolve(name: string, type: string): Promise<string[]>;

  /** Close -- delegates to inner. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// fs-service-backend.mjs
// ---------------------------------------------------------------------------

/**
 * Backend that provides OPFS file access as a service.
 * When connected, returns a socket pair where the server side handles
 * file operation messages (list, read, write, delete).
 */
export class FsServiceBackend extends Backend {
  /**
   * @param opfsRoot - OPFS root directory handle. If not provided,
   *   connect() will attempt to get it via navigator.storage.getDirectory().
   */
  constructor(opfsRoot?: FileSystemDirectoryHandle);

  /**
   * Connect to the filesystem service.
   *
   * @param host - Service path (e.g. 'fs' for svc://fs).
   * @param port - Ignored.
   * @throws ConnectionRefusedError if OPFS is not available.
   */
  connect(host: string, port?: number): Promise<StreamSocket>;
}

// ---------------------------------------------------------------------------
// virtual-network.mjs
// ---------------------------------------------------------------------------

/** Options for creating a ScopedNetwork. */
export interface ScopeOptions {
  /**
   * Capability tags to grant (values from CAPABILITY).
   * @default []
   */
  capabilities?: string[];
  /** Optional custom policy callback. */
  policy?: PolicyCallback;
}

/**
 * Top-level virtual network that routes operations to scheme-specific backends.
 *
 * Comes with a LoopbackBackend registered for 'mem' and 'loop' schemes.
 */
export class VirtualNetwork {
  constructor();

  /**
   * Register an additional backend for a URI scheme.
   *
   * @param scheme - The URI scheme (e.g. 'tcp', 'udp', 'ws', 'svc').
   * @param backend - The backend implementation.
   */
  addBackend(scheme: string, backend: Backend): void;

  /** An array of all registered URI scheme strings. */
  readonly schemes: string[];

  /**
   * Open a stream connection to the given address.
   *
   * @param address - Full address (e.g. "mem://localhost:8080").
   * @throws UnknownSchemeError if the scheme has no registered backend.
   * @throws ConnectionRefusedError if the target refuses the connection.
   */
  connect(address: string): Promise<StreamSocket>;

  /**
   * Start listening for incoming stream connections.
   *
   * @param address - Full address (e.g. "mem://localhost:8080"). Use port 0 for auto-assignment.
   * @throws UnknownSchemeError if the scheme has no registered backend.
   * @throws AddressInUseError if the port is already in use.
   */
  listen(address: string): Promise<Listener>;

  /**
   * Send a datagram to the given address.
   *
   * @param address - Full address (e.g. "mem://localhost:5353").
   * @param data - The datagram payload.
   * @throws UnknownSchemeError if the scheme has no registered backend.
   */
  sendDatagram(address: string, data: Uint8Array): Promise<void>;

  /**
   * Bind a datagram socket on the given address.
   *
   * @param address - Full address. Use port 0 for auto-assignment.
   * @throws UnknownSchemeError if the scheme has no registered backend.
   * @throws AddressInUseError if the port is already in use.
   */
  bindDatagram(address: string): Promise<DatagramSocket>;

  /**
   * Resolve a hostname by querying all registered backends.
   * Returns the first successful result or an empty array.
   *
   * @param name - The hostname to resolve.
   * @param type - DNS record type (e.g. 'A', 'AAAA').
   * @default type 'A'
   */
  resolve(name: string, type?: string): Promise<string[]>;

  /**
   * Create a ScopedNetwork that enforces capability-based policy checks.
   */
  scope(opts?: ScopeOptions): ScopedNetwork;

  /** Close the network and all registered backends. */
  close(): Promise<void>;
}

/**
 * A policy-enforcing wrapper around a VirtualNetwork.
 *
 * Every operation first checks whether the scope's capabilities permit it.
 * For 'mem' and 'loop' schemes, CAPABILITY.LOOPBACK is required;
 * for other schemes, the protocol-specific tag is required.
 */
export class ScopedNetwork {
  constructor(network: VirtualNetwork, policy: PolicyEngine, scopeId: string);

  /**
   * Open a stream connection with policy enforcement.
   *
   * @param address - Full address.
   * @throws PolicyDeniedError if the scope lacks the required capability.
   * @throws UnknownSchemeError if the scheme has no registered backend.
   * @throws ConnectionRefusedError if the target refuses.
   */
  connect(address: string): Promise<StreamSocket>;

  /**
   * Start listening with policy enforcement.
   *
   * @param address - Full address.
   * @throws PolicyDeniedError if the scope lacks the required capability.
   * @throws UnknownSchemeError if the scheme has no registered backend.
   * @throws AddressInUseError if the port is already in use.
   */
  listen(address: string): Promise<Listener>;

  /**
   * Send a datagram with policy enforcement.
   *
   * @param address - Full address.
   * @param data - The datagram payload.
   * @throws PolicyDeniedError if the scope lacks the required capability.
   * @throws UnknownSchemeError if the scheme has no registered backend.
   */
  sendDatagram(address: string, data: Uint8Array): Promise<void>;

  /**
   * Bind a datagram socket with policy enforcement.
   *
   * @param address - Full address.
   * @throws PolicyDeniedError if the scope lacks the required capability.
   * @throws UnknownSchemeError if the scheme has no registered backend.
   * @throws AddressInUseError if the port is already in use.
   */
  bindDatagram(address: string): Promise<DatagramSocket>;

  /**
   * Resolve a hostname with policy enforcement (requires dns:resolve capability).
   *
   * @param name - The hostname to resolve.
   * @param type - DNS record type.
   * @throws PolicyDeniedError if the scope lacks the dns:resolve capability.
   */
  resolve(name: string, type?: string): Promise<string[]>;
}
