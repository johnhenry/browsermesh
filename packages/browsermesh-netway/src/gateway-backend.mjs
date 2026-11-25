/**
 * GatewayBackend — proxies network operations through a wsh (WebSocket Shell)
 * server to perform real TCP/UDP/DNS from the browser.
 *
 * When the wsh client is authenticated, operations are sent immediately as
 * control messages over the WebSocket. When the client is disconnected or not
 * yet authenticated, operations are queued in an {@link OperationQueue} and
 * drained automatically once connectivity is restored (call {@link GatewayBackend#drain}).
 *
 * The backend communicates with the server using a binary control protocol where
 * message types are identified by numeric codes (0x70-0x7d). Responses are
 * dispatched to pending promises via gateway/listener IDs.
 *
 * @module gateway-backend
 */

import { Backend } from './backend.mjs';
import { StreamSocket, AsyncBuffer, DEFAULT_WINDOW_BYTES } from './stream-socket.mjs';

// Flow control. A gateway connection is a pair [userSocket, relaySocket]; the
// user's writes reach the wire through a pump on the relay side, which awaits
// each send, so the relay side always takes a window and the user's `write()`
// is paced by the wire.
//
// Data arriving FROM the wire is metered by wsh's `gateway-credit` when the host
// states that feature (`wshClient.hasFeature('gateway-credit')`): each direction
// of each connection starts with GATEWAY_CREDIT_WINDOW bytes of credit, the
// receiver returns credit (GatewayCredit, 0x7f) as its application takes data
// in, and a sender never has more than the credit it holds in flight.
//   - To the host: the pump sends only while it holds the host's credit, in
//     frames of at most GATEWAY_MAX_FRAME, and waits for a 0x7f otherwise. The
//     wait ends when the connection closes, the user destroys the socket, the
//     gateway closes it, or the wsh client's transport closes.
//   - From the host: the user side takes the same window as any socket, and
//     credit is returned as bytes are accepted into it, i.e. as the consumer
//     reads, so a consumer that stops reading stops the host's origin.
//     At most the window plus the credit granted is ever held.
// Without the feature (an older host, or a client that cannot say), nothing is
// metered on the wire and the user side has no window: the behaviour from before
// credit existed (queued, closed at the chunk cap).
const GATEWAY_CREDIT_FEATURE = 'gateway-credit';
const GATEWAY_CREDIT = 0x7f;
/** Credit each direction of a connection starts with (a wsh protocol constant), and the window netway grants. */
const GATEWAY_CREDIT_WINDOW = 262_144;
/** Largest GatewayData payload sent while credit is on (wsh's own client sends the same). */
const GATEWAY_MAX_FRAME = 65_536;
import { DatagramSocket } from './datagram-socket.mjs';
import { Listener } from './listener.mjs';
import { OperationQueue } from './queue.mjs';
import { ConnectionRefusedError, NetwayError, OperationTimeoutError, SocketClosedError } from './errors.mjs';
import { GATEWAY_ERROR } from './constants.mjs';

/** Default timeout (ms) for gateway operations that await a server response. */
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;

/**
 * The credit the host has granted for sending on one connection. `take` hands out
 * up to `max` bytes and waits while there are none; `fail` ends every wait.
 * @private
 */
class CreditGate {
  #available;
  #waiters = [];
  #failed = false;

  constructor(initial) { this.#available = initial; }

  get available() { return this.#available; }

  grant(n) {
    if (this.#failed || !Number.isFinite(n) || n <= 0) return;
    this.#available = Math.min(this.#available + n, Number.MAX_SAFE_INTEGER);
    this.#wake();
  }

  async take(max) {
    while (this.#available <= 0) {
      if (this.#failed) throw new SocketClosedError();
      await new Promise((resolve) => this.#waiters.push(resolve));
    }
    if (this.#failed) throw new SocketClosedError();
    const n = Math.min(max, this.#available);
    this.#available -= n;
    return n;
  }

  fail() {
    this.#failed = true;
    this.#wake();
  }

  #wake() {
    for (const w of this.#waiters.splice(0)) w();
  }
}

/**
 * A backend that proxies all networking through a remote wsh gateway server.
 *
 * @extends Backend
 */
export class GatewayBackend extends Backend {
  #wshClient;
  #queue;
  #pendingConnections = new Map();  // gateway_id -> { resolve, reject } (TCP)
  #pendingUdp = new Map();          // gateway_id -> { resolve, reject, data } (UDP)
  #pendingListens = new Map();      // listener_id -> { resolve, reject, listener }
  #pendingDns = new Map();          // gateway_id -> { resolve, reject }
  #activeListeners = new Map();     // listener_id -> Listener
  #flows = new Map();               // gateway_id -> { socket (relay side), gate (send credit or null), unacked }
  #closed = false;
  #gatewayIdCounter = 0;
  #listenerIdCounter = 0;
  #operationTimeoutMs;

  /**
   * Create a GatewayBackend.
   *
   * @param {Object} [opts={}]
   * @param {Object} opts.wshClient - A wsh client instance. Must expose
   *   `state` (string), `sendControl(msg)` (async), and an assignable
   *   `onGatewayMessage` callback property.
   * @param {Object} [opts.queueConfig] - Configuration passed to the internal
   *   {@link OperationQueue} (accepts `maxSize` and `drainTimeoutMs`).
   * @param {number} [opts.operationTimeoutMs=30000] - Timeout in milliseconds
   *   for gateway operations (connect, listen, resolve, sendDatagram). Set to
   *   `0` to disable timeouts.
   */
  constructor({ wshClient, queueConfig, operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS } = {}) {
    super();
    this.#wshClient = wshClient;
    this.#queue = new OperationQueue(queueConfig);
    this.#operationTimeoutMs = operationTimeoutMs;
    if (wshClient) {
      wshClient.onGatewayMessage = (msg) => this.#handleGatewayMessage(msg);
      // A client that can say when its transport closed (wsh's WshClient has `onClose`): end every
      // connection and every wait for credit, and call the handler that was there before.
      if ('onClose' in wshClient) {
        const previous = wshClient.onClose;
        wshClient.onClose = (...args) => {
          this.#failFlows();
          return typeof previous === 'function' ? previous.apply(wshClient, args) : undefined;
        };
      }
    }
  }

  /** Whether the host stated `gateway-credit`, so the connections opened from now on are metered. @private */
  #creditOn() {
    const client = this.#wshClient;
    return typeof client?.hasFeature === 'function' && client.hasFeature(GATEWAY_CREDIT_FEATURE) === true;
  }

  /**
   * Make the two sockets of a new connection and register the relay side.
   * The user side gets a receive window only when the connection is metered.
   * @returns {{ userSocket: StreamSocket, flow: object }}
   * @private
   */
  #openFlow(gatewayId) {
    const credit = this.#creditOn();
    const toRelay = new AsyncBuffer({ highWaterMark: 1024, windowBytes: DEFAULT_WINDOW_BYTES }); // user -> wire
    const toUser = new AsyncBuffer({ highWaterMark: 1024, windowBytes: credit ? DEFAULT_WINDOW_BYTES : 0 }); // wire -> user
    const userSocket = new StreamSocket({ inbound: toUser, outbound: toRelay });
    const relaySocket = new StreamSocket({ inbound: toRelay, outbound: toUser });
    const flow = { socket: relaySocket, gate: credit ? new CreditGate(GATEWAY_CREDIT_WINDOW) : null, unacked: 0 };
    this.#flows.set(gatewayId, flow);
    // The user destroyed their socket, or the relay side was closed: a pump waiting for credit stops waiting.
    toRelay.whenAborted().then(() => flow.gate?.fail());
    return { userSocket, flow };
  }

  /** Close every connection and end every wait for credit (the transport is gone, or the backend closed). @private */
  #failFlows() {
    const flows = [...this.#flows.values()];
    this.#flows.clear();
    for (const flow of flows) {
      flow.gate?.fail();
      flow.socket.close().catch(() => {});
    }
  }

  /**
   * Whether the backend is currently able to send operations to the gateway.
   * Returns `true` when not closed and the wsh client is in the `'authenticated'` state.
   */
  get connected() {
    return !this.#closed && this.#wshClient?.state === 'authenticated';
  }

  /** @private */
  #nextGatewayId() { return ++this.#gatewayIdCounter; }
  /** @private */
  #nextListenerId() { return ++this.#listenerIdCounter; }

  /**
   * Open a stream connection through the gateway. If the gateway is not
   * connected, the operation is queued and the returned promise settles when
   * the queue is drained.
   *
   * @param {string} host - The remote hostname or IP.
   * @param {number} port - The remote port number.
   * @returns {Promise<import('./stream-socket.mjs').StreamSocket>} The client-side socket.
   * @throws {ConnectionRefusedError} If the remote end refuses the connection.
   * @throws {QueueFullError} If offline and the operation queue is full.
   */
  async connect(host, port) {
    if (!this.connected) {
      return this.#queue.enqueue({ type: 'connect', host, port });
    }
    return this.#doConnect(host, port);
  }

  /**
   * Wrap a pending operation promise with an optional timeout. When the timeout
   * fires, the pending entry is removed from the map and the promise is rejected
   * with an {@link OperationTimeoutError}.
   *
   * @param {Promise} promise - The operation promise.
   * @param {string} opName - Human-readable operation name for error messages.
   * @param {number|string} id - The gateway_id or listener_id.
   * @param {Map} pendingMap - The pending map to clean up on timeout.
   * @returns {Promise} The original promise, or a race against the timeout.
   * @private
   */
  #withTimeout(promise, opName, id, pendingMap) {
    if (!this.#operationTimeoutMs) return promise;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingMap.delete(id);
        reject(new OperationTimeoutError(opName));
      }, this.#operationTimeoutMs);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }

  /**
   * Send an OPEN_TCP (0x70) control message and wait for GATEWAY_OK/FAIL.
   * @private
   */
  async #doConnect(host, port) {
    const gatewayId = this.#nextGatewayId();
    const msg = { type: 0x70, gateway_id: gatewayId, host, port }; // OPEN_TCP
    await this.#wshClient.sendControl(msg);

    const p = new Promise((resolve, reject) => {
      this.#pendingConnections.set(gatewayId, { resolve, reject });
    });
    return this.#withTimeout(p, `connect ${host}:${port}`, gatewayId, this.#pendingConnections);
  }

  /**
   * Request the gateway to listen for incoming connections on a port. If
   * offline, the operation is queued.
   *
   * @param {number} port - The port to listen on. Pass `0` for server-assigned.
   * @returns {Promise<import('./listener.mjs').Listener>} A listener bound to
   *   the actual (possibly server-assigned) port.
   * @throws {NetwayError} If the server rejects the listen request.
   * @throws {QueueFullError} If offline and the operation queue is full.
   */
  async listen(port) {
    if (!this.connected) {
      return this.#queue.enqueue({ type: 'listen', port });
    }
    return this.#doListen(port);
  }

  /**
   * Send a LISTEN_REQUEST (0x7a) and wait for LISTEN_OK/FAIL.
   * @private
   */
  async #doListen(port) {
    const listenerId = this.#nextListenerId();
    const listener = new Listener({ localPort: port });
    const msg = { type: 0x7a, listener_id: listenerId, port, bind_addr: '0.0.0.0' }; // LISTEN_REQUEST
    await this.#wshClient.sendControl(msg);

    const p = new Promise((resolve, reject) => {
      this.#pendingListens.set(listenerId, { resolve, reject, listener });
    });
    return this.#withTimeout(p, `listen :${port}`, listenerId, this.#pendingListens);
  }

  /**
   * Send a datagram through the gateway. If offline, the operation is queued.
   *
   * Opens a UDP channel via OPEN_UDP (0x71), waits for GATEWAY_OK, then
   * sends the payload as a GatewayData (0x7e) message.
   *
   * @param {string} host - The target hostname or IP.
   * @param {number} port - The target port number.
   * @param {Uint8Array} data - The datagram payload.
   * @returns {Promise<void>}
   * @throws {ConnectionRefusedError} If the gateway rejects the UDP open.
   * @throws {QueueFullError} If offline and the operation queue is full.
   */
  async sendDatagram(host, port, data) {
    if (!this.connected) {
      return this.#queue.enqueue({ type: 'sendDatagram', host, port, data });
    }
    return this.#doSendDatagram(host, port, data);
  }

  /**
   * Send an OPEN_UDP (0x71), wait for GATEWAY_OK, then send data as GatewayData.
   * @private
   */
  async #doSendDatagram(host, port, data) {
    const gatewayId = this.#nextGatewayId();
    const msg = { type: 0x71, gateway_id: gatewayId, host, port }; // OPEN_UDP
    await this.#wshClient.sendControl(msg);

    const p = new Promise((resolve, reject) => {
      this.#pendingUdp.set(gatewayId, { resolve, reject, data });
    });
    return this.#withTimeout(p, `sendDatagram ${host}:${port}`, gatewayId, this.#pendingUdp);
  }

  /**
   * Resolve a hostname through the gateway's DNS. If offline, the operation
   * is queued.
   *
   * @param {string} name - The hostname to resolve.
   * @param {string} [type='A'] - DNS record type (e.g. `'A'`, `'AAAA'`).
   * @returns {Promise<string[]>} An array of resolved address strings.
   * @throws {ConnectionRefusedError} If the gateway reports a DNS failure.
   * @throws {QueueFullError} If offline and the operation queue is full.
   */
  async resolve(name, type = 'A') {
    if (!this.connected) {
      return this.#queue.enqueue({ type: 'resolve', name, recordType: type });
    }
    return this.#doResolve(name, type);
  }

  /**
   * Send a RESOLVE_DNS (0x72) message and wait for DNS_RESULT/GATEWAY_FAIL.
   * @private
   */
  async #doResolve(name, type) {
    const gatewayId = this.#nextGatewayId();
    const msg = { type: 0x72, gateway_id: gatewayId, name, record_type: type }; // RESOLVE_DNS
    await this.#wshClient.sendControl(msg);

    const p = new Promise((resolve, reject) => {
      this.#pendingDns.set(gatewayId, { resolve, reject });
    });
    return this.#withTimeout(p, `resolve ${name}`, gatewayId, this.#pendingDns);
  }

  /**
   * Start a data pump that reads from a relay socket and sends GatewayData
   * messages to the server. Runs until the relay socket closes.
   *
   * @param {number} gatewayId - The gateway_id for this connection.
   * @param {import('./stream-socket.mjs').StreamSocket} relaySocket - The relay side of the socket pair.
   * @private
   */
  #startDataPump(gatewayId, relaySocket) {
    const flow = this.#flows.get(gatewayId);
    (async () => {
      let transportError = false;
      try {
        while (true) {
          const chunk = await relaySocket.read();
          if (chunk === null) break; // socket closed
          await this.#sendData(gatewayId, flow, chunk, () => { transportError = true; });
        }
      } catch (_) {
        // Transport closed or errored, the user destroyed the socket, or the connection was closed while
        // waiting for credit. Close the relay socket so user-side reads return null (EOF) instead of
        // hanging indefinitely.
        await relaySocket.close();
        this.#flows.delete(gatewayId);
      }
      // Tell server the channel is done (best-effort); a dead transport cannot be told.
      if (!transportError) {
        await this.#wshClient.sendControl({
          type: 0x75, gateway_id: gatewayId,
        }).catch(() => {});
      }
    })();
  }

  /**
   * Send one chunk to the host. With credit on, in frames of at most GATEWAY_MAX_FRAME, each only as
   * far as the host's credit allows (the wait ends if the connection ends: `take` then throws).
   * @param {() => void} onTransportError - called when the send itself fails, before the error is rethrown
   * @private
   */
  async #sendData(gatewayId, flow, chunk, onTransportError) {
    const send = async (data) => {
      try {
        await this.#wshClient.sendControl({ type: 0x7e, gateway_id: gatewayId, data });
      } catch (e) {
        onTransportError();
        throw e;
      }
    };
    if (!flow?.gate) return send(chunk);
    for (let off = 0; off < chunk.length;) {
      const n = await flow.gate.take(Math.min(chunk.length - off, GATEWAY_MAX_FRAME));
      await send(chunk.subarray(off, off + n));
      off += n;
    }
  }

  /**
   * Data from the host reached the user side: hand it to the relay socket and, once the user side has
   * taken it into its window (the consumer has made room), return that much credit to the host.
   * @private
   */
  #deliver(gatewayId, flow, data) {
    flow.socket.write(data).then(() => {
      if (!flow.gate || this.#flows.get(gatewayId) !== flow) return;
      flow.unacked += data.length;
      if (flow.unacked >= GATEWAY_CREDIT_WINDOW / 2) {
        const bytes = flow.unacked;
        flow.unacked = 0;
        this.#wshClient.sendControl({ type: GATEWAY_CREDIT, gateway_id: gatewayId, bytes }).catch(() => {});
      }
    }, () => {});
  }

  /**
   * Handle an inbound gateway control message from the wsh server.
   *
   * Dispatches by message type code:
   * - **0x73 GATEWAY_OK** — Resolves a pending connection with a new StreamSocket pair.
   * - **0x74 GATEWAY_FAIL** — Rejects a pending connection or DNS request.
   * - **0x75 GATEWAY_CLOSE** — Closes an active relayed socket.
   * - **0x76 INBOUND_OPEN** — Auto-accepts an incoming connection on an active listener.
   * - **0x7e GATEWAY_DATA** — Pushes received data into the matching relay socket, and returns credit to the host as it is taken in.
   * - **0x7f GATEWAY_CREDIT** — The host lets the pump send more on a connection (only when `gateway-credit` is on).
   * - **0x79 DNS_RESULT** — Resolves a pending DNS request with addresses.
   * - **0x7b LISTEN_OK** — Resolves a pending listen with the bound listener.
   * - **0x7c LISTEN_FAIL** — Rejects a pending listen request.
   * - **0x7d LISTEN_CLOSE** — Closes a server-side listener.
   *
   * @param {Object} msg - The decoded gateway control message.
   * @private
   */
  #handleGatewayMessage(msg) {
    const type = msg.type;

    switch (type) {
      case 0x73: { // GATEWAY_OK
        const pendingTcp = this.#pendingConnections.get(msg.gateway_id);
        const pendingUdp = this.#pendingUdp.get(msg.gateway_id);
        if (pendingTcp) {
          this.#pendingConnections.delete(msg.gateway_id);
          // Create a StreamSocket pair — one side for the user, one for wsh data relay
          const { userSocket, flow } = this.#openFlow(msg.gateway_id);
          pendingTcp.resolve(userSocket);
          // Start pumping data from relay socket to server
          this.#startDataPump(msg.gateway_id, flow.socket);
        } else if (pendingUdp) {
          // UDP: send queued datagram payload and close the channel
          this.#pendingUdp.delete(msg.gateway_id);
          this.#wshClient.sendControl({
            type: 0x7e, gateway_id: msg.gateway_id, data: pendingUdp.data,
          }).then(() => {
            this.#wshClient.sendControl({
              type: 0x75, gateway_id: msg.gateway_id,
            }).catch(() => {});
            pendingUdp.resolve();
          }).catch(pendingUdp.reject);
        }
        break;
      }

      case 0x74: { // GATEWAY_FAIL
        const pending = this.#pendingConnections.get(msg.gateway_id)
          || this.#pendingUdp.get(msg.gateway_id)
          || this.#pendingDns.get(msg.gateway_id);
        if (pending) {
          this.#pendingConnections.delete(msg.gateway_id);
          this.#pendingUdp.delete(msg.gateway_id);
          this.#pendingDns.delete(msg.gateway_id);
          const detail = `${msg.message} (code: ${msg.code})`;
          if (msg.code === GATEWAY_ERROR.TIMEOUT) {
            pending.reject(new OperationTimeoutError(detail));
          } else if (msg.code === GATEWAY_ERROR.GATEWAY_DISABLED) {
            // 5 is what the Rust server sends when its gateway is off, and what a Node gateway at 0.51.0 or earlier sent for a timeout.
            pending.reject(new ConnectionRefusedError(`${detail}: the gateway is disabled, or a timeout from an older gateway`));
          } else {
            pending.reject(new ConnectionRefusedError(detail));
          }
        }
        break;
      }

      case 0x75: { // GATEWAY_CLOSE
        const flow = this.#flows.get(msg.gateway_id);
        if (flow) {
          flow.gate?.fail(); // a write waiting for the host's credit ends: the host will grant none now
          flow.socket.close();
          this.#flows.delete(msg.gateway_id);
        }
        break;
      }

      case 0x76: { // INBOUND_OPEN
        const listener = this.#activeListeners.get(msg.listener_id);
        if (listener && !listener.closed) {
          // Auto-accept: create socket pair, enqueue server socket, send accept
          const gatewayId = this.#nextGatewayId();
          const { userSocket, flow } = this.#openFlow(gatewayId);
          listener._enqueue(userSocket);
          // Send InboundAccept with gateway_id for data routing
          this.#wshClient.sendControl({
            type: 0x77, channel_id: msg.channel_id, gateway_id: gatewayId,
          }).catch(() => {});
          // Start pumping data from relay socket to server
          this.#startDataPump(gatewayId, flow.socket);
        } else {
          // Reject if no listener
          this.#wshClient.sendControl({ type: 0x78, channel_id: msg.channel_id, reason: 'no listener' }).catch(() => {});
        }
        break;
      }

      case 0x7e: { // GATEWAY_DATA
        const flow = this.#flows.get(msg.gateway_id);
        if (flow) this.#deliver(msg.gateway_id, flow, msg.data);
        break;
      }

      case GATEWAY_CREDIT: { // the host lets us send `bytes` more on gateway_id
        this.#flows.get(msg.gateway_id)?.gate?.grant(msg.bytes);
        break;
      }

      case 0x79: { // DNS_RESULT
        const pending = this.#pendingDns.get(msg.gateway_id);
        if (pending) {
          this.#pendingDns.delete(msg.gateway_id);
          pending.resolve(msg.addresses);
        }
        break;
      }

      case 0x7b: { // LISTEN_OK
        const pending = this.#pendingListens.get(msg.listener_id);
        if (pending) {
          this.#pendingListens.delete(msg.listener_id);
          // Update listener with actual bound port from server
          if (msg.actual_port != null) {
            pending.listener._setLocalPort(msg.actual_port);
          }
          this.#activeListeners.set(msg.listener_id, pending.listener);
          pending.resolve(pending.listener);
        }
        break;
      }

      case 0x7c: { // LISTEN_FAIL
        const pending = this.#pendingListens.get(msg.listener_id);
        if (pending) {
          this.#pendingListens.delete(msg.listener_id);
          pending.reject(new NetwayError(msg.reason, 'ELISTENFAIL'));
        }
        break;
      }

      case 0x7d: { // LISTEN_CLOSE
        const listener = this.#activeListeners.get(msg.listener_id);
        if (listener) {
          listener.close();
          this.#activeListeners.delete(msg.listener_id);
        }
        break;
      }
    }
  }

  /**
   * Drain all queued operations by executing them against the (now-connected)
   * gateway. Call this after the wsh client reconnects and re-authenticates.
   * Operations are replayed in FIFO order.
   *
   * @returns {Promise<void>} Resolves when all queued operations have been processed.
   */
  async drain() {
    await this.#queue.drain(async (op) => {
      switch (op.type) {
        case 'connect': return this.#doConnect(op.host, op.port);
        case 'listen': return this.#doListen(op.port);
        case 'resolve': return this.#doResolve(op.name, op.recordType);
        case 'sendDatagram': return this.#doSendDatagram(op.host, op.port, op.data);
        default: throw new Error(`Unknown queued op: ${op.type}`);
      }
    });
  }

  /**
   * Close the backend. Clears the operation queue (rejecting pending promises),
   * closes all active sockets and listeners, and rejects all outstanding
   * connection/listen/DNS requests with an `ECLOSED` error.
   *
   * @returns {Promise<void>}
   */
  async close() {
    this.#closed = true;
    this.#queue.clear();
    for (const flow of this.#flows.values()) { flow.gate?.fail(); await flow.socket.close(); }
    for (const listener of this.#activeListeners.values()) listener.close();
    this.#flows.clear();
    this.#activeListeners.clear();
    // Reject all pending
    for (const p of this.#pendingConnections.values()) p.reject(new NetwayError('Backend closed', 'ECLOSED'));
    for (const p of this.#pendingUdp.values()) p.reject(new NetwayError('Backend closed', 'ECLOSED'));
    for (const p of this.#pendingListens.values()) p.reject(new NetwayError('Backend closed', 'ECLOSED'));
    for (const p of this.#pendingDns.values()) p.reject(new NetwayError('Backend closed', 'ECLOSED'));
    this.#pendingConnections.clear();
    this.#pendingUdp.clear();
    this.#pendingListens.clear();
    this.#pendingDns.clear();
  }
}
