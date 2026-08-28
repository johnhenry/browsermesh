/**
 * netway — Virtual networking layer for browser environments.
 *
 * Provides TCP-like streams, UDP-like datagrams, DNS resolution, and
 * capability-based policy enforcement, all running in-memory or proxied through
 * a remote gateway server.
 *
 * ## Quick start
 *
 * ```js
 * import { VirtualNetwork, CAPABILITY, GatewayBackend } from 'netway';
 *
 * // 1. Create a network (comes with in-memory loopback for mem:// and loop://)
 * const net = new VirtualNetwork();
 *
 * // 2. Listen and connect over the loopback backend
 * const listener = await net.listen('mem://localhost:8080');
 * const client   = await net.connect('mem://localhost:8080');
 * const server   = await listener.accept();
 *
 * await client.write(new TextEncoder().encode('hello'));
 * const chunk = await server.read(); // Uint8Array: "hello"
 *
 * // 3. Scoped policy enforcement
 * const sandbox = net.scope({ capabilities: [CAPABILITY.LOOPBACK] });
 * await sandbox.connect('mem://localhost:8080'); // allowed
 * // sandbox.connect('tcp://example.com:80');    // throws PolicyDeniedError
 *
 * // 4. Real networking via GatewayBackend (requires a wsh server)
 * // const gateway = new GatewayBackend({ wshClient });
 * // net.addBackend('tcp', gateway);
 * // const socket = await net.connect('tcp://example.com:80');
 *
 * await net.close();
 * ```
 *
 * ## Module map
 *
 * | Module              | Purpose                                          |
 * |---------------------|--------------------------------------------------|
 * | constants           | Defaults, error codes, capability tags            |
 * | errors              | Error hierarchy (NetwayError and subclasses)      |
 * | stream-socket       | Reliable ordered byte stream (TCP-like)           |
 * | datagram-socket     | Unreliable message socket (UDP-like)              |
 * | listener            | Server-side accept queue                          |
 * | policy              | Capability-based access control engine            |
 * | router              | Address parsing and scheme-to-backend dispatch    |
 * | queue               | Offline operation queue with deferred drain       |
 * | backend             | Abstract base class for network backends          |
 * | loopback-backend    | In-memory backend (mem://, loop://)               |
 * | gateway-backend     | wsh-proxied backend for real TCP/UDP/DNS          |
 * | virtual-network     | Top-level facade composing all of the above       |
 *
 * @module netway
 */

// Constants + errors
export { DEFAULTS, GATEWAY_ERROR, CAPABILITY } from './constants.mjs';
export {
  NetwayError, ConnectionRefusedError, PolicyDeniedError,
  AddressInUseError, QueueFullError, UnknownSchemeError, SocketClosedError,
  OperationTimeoutError,
} from './errors.mjs';

// Core abstractions
export { StreamSocket } from './stream-socket.mjs';
export { DatagramSocket } from './datagram-socket.mjs';
export { Listener } from './listener.mjs';

// Policy + routing
export { PolicyEngine } from './policy.mjs';
export { Router, parseAddress } from './router.mjs';
export { OperationQueue } from './queue.mjs';

// Backends
export { Backend } from './backend.mjs';
export { LoopbackBackend } from './loopback-backend.mjs';
export { GatewayBackend } from './gateway-backend.mjs';
export { ServiceBackend } from './service-backend.mjs';
export { ChaosBackendWrapper } from './chaos-backend-wrapper.mjs';
export { FsServiceBackend } from './fs-service-backend.mjs';

// Network
export { VirtualNetwork, ScopedNetwork } from './virtual-network.mjs';
