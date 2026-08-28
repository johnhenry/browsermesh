/**
 * clawser-mesh-relay.js -- Relay Client for Peer Discovery & Signal Forwarding.
 *
 * Two paths:
 *   1. MockRelayServer — in-memory, used by tests and offline scenarios.
 *      Construction/connect parity with the real path.
 *   2. Real WebSocket — connects to a relay server URL and serializes
 *      the same protocol surface (register / announce / find / signal /
 *      peer_announce). Auto-reconnects with exponential backoff.
 *
 * Wire protocol (JSON over WS, mirrors MockRelayServer methods):
 *   client → server:
 *     {type:'register', fingerprint}
 *     {type:'announce', fingerprint, capabilities}
 *     {type:'find', requestId, query}            → expects find_response
 *     {type:'signal',  from, to, signal}
 *   server → client:
 *     {type:'peer_announce', fingerprint, capabilities}
 *     {type:'signal',  from, signal}
 *     {type:'find_response', requestId, peers}
 *     {type:'error',   message}
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-relay.test.mjs
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @type {readonly string[]} */
const RELAY_STATES = Object.freeze([
  'disconnected',
  'connecting',
  'connected',
]);

// ---------------------------------------------------------------------------
// MockRelayServer
// ---------------------------------------------------------------------------

/**
 * In-memory relay server for testing.
 * Tracks connected clients and forwards signals between them.
 */
export class MockRelayServer {
  /** @type {Map<string, MeshRelayClient>} fingerprint -> client */
  #clients = new Map();

  /**
   * Register a client with the relay.
   *
   * @param {MeshRelayClient} client
   */
  registerClient(client) {
    this.#clients.set(client.fingerprint, client);
  }

  /**
   * Remove a client by fingerprint.
   *
   * @param {string} fingerprint
   * @returns {boolean} true if the client existed
   */
  removeClient(fingerprint) {
    return this.#clients.delete(fingerprint);
  }

  /**
   * Get all currently connected peers as descriptors.
   *
   * @returns {Array<{ fingerprint: string, capabilities: string[], endpoint: string|null }>}
   */
  getConnectedPeers() {
    return [...this.#clients.values()].map(c => ({
      fingerprint: c.fingerprint,
      capabilities: [...c._announcedCapabilities],
      endpoint: c._endpoint,
    }));
  }

  /**
   * Find peers matching a query.
   * Supports filtering by `capability` (string) -- returns peers whose
   * capabilities array includes the value.
   *
   * @param {object} [query]
   * @param {string} [query.capability] - Required capability
   * @returns {Array<{ fingerprint: string, capabilities: string[], endpoint: string|null }>}
   */
  findPeers(query = {}) {
    let peers = this.getConnectedPeers();
    if (query.capability) {
      peers = peers.filter(p => p.capabilities.includes(query.capability));
    }
    return peers;
  }

  /**
   * Forward a signaling message from one client to another.
   * Delivers via the target client's internal signal handler if connected.
   *
   * @param {string} fromFingerprint
   * @param {string} toFingerprint
   * @param {*} signal - Signal data (SDP offer/answer, ICE candidate, etc.)
   * @returns {boolean} true if the signal was delivered
   */
  forwardSignal(fromFingerprint, toFingerprint, signal) {
    const target = this.#clients.get(toFingerprint);
    if (!target) return false;
    target._deliverSignal(fromFingerprint, signal);
    return true;
  }

  /**
   * Notify all connected clients about a peer announcement.
   * Skips the announcing client itself.
   *
   * @param {string} fingerprint - The announcing peer
   * @param {string[]} capabilities
   */
  broadcastPresence(fingerprint, capabilities) {
    for (const [fp, client] of this.#clients) {
      if (fp === fingerprint) continue;
      client._deliverPeerAnnounce({ fingerprint, capabilities });
    }
  }

  /** @returns {number} */
  get size() {
    return this.#clients.size;
  }
}

// ---------------------------------------------------------------------------
// MeshRelayClient
// ---------------------------------------------------------------------------

/**
 * Client for connecting to a signaling/relay server.
 *
 * Handles peer discovery and signal forwarding for establishing
 * direct peer-to-peer connections (WebRTC offers/answers, ICE candidates).
 *
 * State machine: disconnected -> connecting -> connected -> disconnected
 */
export class MeshRelayClient {
  /** @type {string} */
  #relayUrl;

  /** @type {string} */
  #fingerprint;

  /** @type {string} */
  #state = 'disconnected';

  /** @type {MockRelayServer|null} */
  #server = null;

  /** @type {Function} */
  #onLog;

  /** @type {Function[]} */
  #signalCallbacks = [];

  /** @type {Function[]} */
  #peerAnnounceCallbacks = [];

  /** @type {Function[]} */
  #connectCallbacks = [];

  /** @type {Function[]} */
  #disconnectCallbacks = [];

  /** @type {Function[]} */
  #errorCallbacks = [];

  /** @type {string[]} Exposed for MockRelayServer to read. */
  _announcedCapabilities = [];

  /** @type {string|null} Exposed for MockRelayServer to read. */
  _endpoint = null;

  /** @type {number} */
  #knownPeerCount = 0;

  /** @type {WebSocket|null} Real WS used when no MockRelayServer is given. */
  #ws = null;

  /** @type {boolean} True after .disconnect() / consumer-initiated close. */
  #userClosed = false;

  /** @type {number} */
  #reconnectAttempts = 0;

  /** @type {number} */
  #maxReconnectAttempts;

  /** @type {number} */
  #reconnectDelayMs;

  /** @type {boolean} */
  #autoReconnect;

  /** @type {Function|null} - WebSocket constructor override (Node tests). */
  #WebSocketCtor;

  /** @type {Map<string, {resolve:Function, reject:Function, timer:any}>} */
  #pendingFinds = new Map();

  /** @type {number} */
  #findSeq = 0;

  /**
   * @param {object} opts
   * @param {string} opts.relayUrl - WebSocket endpoint for the relay
   * @param {{ fingerprint: string }} opts.identity - Local identity
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   * @param {Function} [opts.WebSocket] - Override constructor (Node tests)
   * @param {number} [opts.maxReconnectAttempts=5]
   * @param {number} [opts.reconnectDelayMs=500] - Base delay; exp-backoff multiplies
   * @param {boolean} [opts.autoReconnect=true]
   */
  constructor({ relayUrl, identity, onLog, WebSocket: WSCtor, maxReconnectAttempts, reconnectDelayMs, autoReconnect } = {}) {
    if (!relayUrl || typeof relayUrl !== 'string') {
      throw new Error('relayUrl is required and must be a non-empty string');
    }
    if (!identity || !identity.fingerprint) {
      throw new Error('identity with fingerprint is required');
    }
    this.#relayUrl = relayUrl;
    this.#fingerprint = identity.fingerprint;
    this.#onLog = onLog || (() => {});
    this.#WebSocketCtor = WSCtor || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.#maxReconnectAttempts = maxReconnectAttempts ?? 5;
    this.#reconnectDelayMs = reconnectDelayMs ?? 500;
    this.#autoReconnect = autoReconnect !== false;
  }

  // -- Accessors ------------------------------------------------------------

  /** Relay server URL. */
  get relayUrl() {
    return this.#relayUrl;
  }

  /** Local fingerprint. */
  get fingerprint() {
    return this.#fingerprint;
  }

  /** Current connection state. */
  get state() {
    return this.#state;
  }

  /** True when connected to the relay. */
  get connected() {
    return this.#state === 'connected';
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Connect to the relay server.
   *
   * Two modes:
   *   - With a `MockRelayServer` argument: in-memory test path.
   *   - Without one: opens a real WebSocket to `relayUrl`. Resolves
   *     after the WS open + register handshake, or rejects on failure.
   *
   * @param {MockRelayServer} [mockServer] - Mock server instance for testing
   * @returns {Promise<void>}
   */
  async connect(mockServer) {
    if (this.#state === 'connected') return;
    this.#userClosed = false;
    this.#state = 'connecting';
    this.#onLog(2, `Connecting to relay: ${this.#relayUrl}`);

    try {
      if (mockServer) {
        this.#server = mockServer;
        mockServer.registerClient(this);
        this.#state = 'connected';
        this.#onLog(2, 'Connected to relay (mock)');
        this.#fire(this.#connectCallbacks);
        return;
      }
      await this.#connectRealWs();
      this.#state = 'connected';
      this.#reconnectAttempts = 0;
      this.#onLog(2, 'Connected to relay (ws)');
      this.#fire(this.#connectCallbacks);
    } catch (err) {
      this.#state = 'disconnected';
      this.#fire(this.#errorCallbacks, err);
      throw err;
    }
  }

  /**
   * Disconnect from the relay server.
   */
  disconnect() {
    if (this.#state === 'disconnected') return;
    this.#userClosed = true;
    if (this.#server) {
      this.#server.removeClient(this.#fingerprint);
      this.#server = null;
    }
    if (this.#ws) {
      try { this.#sendWs({ type: 'unregister', fingerprint: this.#fingerprint }); } catch { /* ignore */ }
      try { this.#ws.close(); } catch { /* ignore */ }
      this.#ws = null;
    }
    // Reject any in-flight finds so callers don't hang.
    for (const [, p] of this.#pendingFinds) {
      try { clearTimeout(p.timer); } catch { /* ignore */ }
      p.reject(new Error('relay disconnected'));
    }
    this.#pendingFinds.clear();
    this.#state = 'disconnected';
    this._announcedCapabilities = [];
    this.#knownPeerCount = 0;
    this.#onLog(2, 'Disconnected from relay');
    this.#fire(this.#disconnectCallbacks);
  }

  /**
   * Open the real WebSocket and run the register handshake. Returns
   * when the server has accepted our register message (or `open` if
   * the server is silent).
   * @returns {Promise<void>}
   */
  async #connectRealWs() {
    if (!this.#WebSocketCtor) {
      throw new Error('WebSocket is not available in this environment');
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try { ws = new this.#WebSocketCtor(this.#relayUrl); }
      catch (e) { reject(e); return; }
      this.#ws = ws;

      const onOpen = () => {
        // Send register immediately on open. Server may or may not ack.
        this.#sendWs({ type: 'register', fingerprint: this.#fingerprint });
        if (!settled) { settled = true; resolve(); }
      };
      const onMessage = (ev) => this.#handleWsMessage(ev);
      const onErr = (ev) => {
        const err = ev?.error || new Error('relay ws error');
        if (!settled) { settled = true; reject(err); return; }
        // Post-open errors propagate via callbacks.
        this.#fire(this.#errorCallbacks, err);
      };
      const onClose = () => {
        // Detach so re-opens get fresh handlers.
        try { ws.removeEventListener?.('open', onOpen); } catch { /* ignore */ }
        try { ws.removeEventListener?.('message', onMessage); } catch { /* ignore */ }
        try { ws.removeEventListener?.('error', onErr); } catch { /* ignore */ }
        try { ws.removeEventListener?.('close', onClose); } catch { /* ignore */ }
        if (!settled) { settled = true; reject(new Error('relay ws closed before open')); return; }
        if (this.#userClosed) {
          this.#state = 'disconnected';
          this.#fire(this.#disconnectCallbacks);
          return;
        }
        this.#state = 'disconnected';
        this.#fire(this.#disconnectCallbacks);
        if (this.#autoReconnect) this.#scheduleReconnect();
      };

      // Support both Node `ws` library (.on) and browser (.addEventListener).
      if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('open', onOpen);
        ws.addEventListener('message', onMessage);
        ws.addEventListener('error', onErr);
        ws.addEventListener('close', onClose);
      } else if (typeof ws.on === 'function') {
        ws.on('open', onOpen);
        ws.on('message', (data) => onMessage({ data: typeof data === 'string' ? data : data.toString() }));
        ws.on('error', (err) => onErr({ error: err }));
        ws.on('close', onClose);
      }
    });
  }

  #scheduleReconnect() {
    if (this.#reconnectAttempts >= this.#maxReconnectAttempts) {
      this.#fire(this.#errorCallbacks, new Error(
        `Relay reconnect failed after ${this.#maxReconnectAttempts} attempts (giving up)`,
      ));
      return;
    }
    this.#reconnectAttempts++;
    const delay = this.#reconnectDelayMs * Math.pow(2, this.#reconnectAttempts - 1);
    setTimeout(() => {
      if (this.#userClosed) return;
      this.connect().catch(() => { /* errors already fired */ });
    }, delay);
  }

  #sendWs(msg) {
    if (!this.#ws) return;
    try { this.#ws.send(JSON.stringify(msg)); }
    catch (e) { this.#onLog(3, `relay send failed: ${e?.message || e}`); }
  }

  #handleWsMessage(ev) {
    let msg;
    try { msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; }
    catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'peer_announce':
        this.#fire(this.#peerAnnounceCallbacks, {
          fingerprint: msg.fingerprint,
          capabilities: msg.capabilities || [],
        });
        break;
      case 'signal':
        this.#fire(this.#signalCallbacks, msg.from, msg.signal);
        break;
      case 'find_response': {
        const pending = this.#pendingFinds.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.#pendingFinds.delete(msg.requestId);
          pending.resolve(msg.peers || []);
        }
        break;
      }
      case 'error':
        this.#fire(this.#errorCallbacks, new Error(msg.message || 'relay error'));
        break;
    }
  }

  // -- Presence & Discovery -------------------------------------------------

  /**
   * Announce this peer's presence and capabilities to the relay.
   *
   * @param {string[]} capabilities - List of capability strings to advertise
   */
  announcePresence(capabilities) {
    this.#assertConnected();
    this._announcedCapabilities = [...capabilities];
    this.#onLog(
      2,
      `Announced presence with capabilities: ${capabilities.join(', ')}`,
    );
    if (this.#server) {
      this.#server.broadcastPresence(this.#fingerprint, capabilities);
    } else if (this.#ws) {
      this.#sendWs({
        type: 'announce',
        fingerprint: this.#fingerprint,
        capabilities: [...capabilities],
      });
    }
  }

  /**
   * Query the relay for peers matching criteria.
   *
   * @param {object} [query]
   * @param {string} [query.capability] - Required capability
   * @returns {Promise<Array<{ fingerprint: string, capabilities: string[], endpoint: string|null }>>}
   */
  async findPeers(query = {}) {
    this.#assertConnected();
    if (this.#server) {
      // Mock path
      const peers = this.#server.findPeers(query)
        .filter(p => p.fingerprint !== this.#fingerprint);
      this.#knownPeerCount = peers.length;
      return peers;
    }
    if (this.#ws) {
      // Real WS path: send find request, await response keyed by requestId.
      const requestId = `find_${++this.#findSeq}`;
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pendingFinds.delete(requestId);
          reject(new Error(`relay findPeers timed out after 5s`));
        }, 5000);
        this.#pendingFinds.set(requestId, { resolve, reject, timer });
        this.#sendWs({ type: 'find', requestId, query });
      });
      const filtered = result.filter(p => p.fingerprint !== this.#fingerprint);
      this.#knownPeerCount = filtered.length;
      return filtered;
    }
    return [];
  }

  // -- Signal Forwarding ----------------------------------------------------

  /**
   * Forward a signaling message to a target peer via the relay.
   *
   * @param {string} targetFingerprint - Recipient's fingerprint
   * @param {*} signal - Signal data (SDP offer/answer, ICE candidate, etc.)
   * @returns {boolean} true if the signal was delivered
   */
  forwardSignal(targetFingerprint, signal) {
    this.#assertConnected();
    this.#onLog(2, `Forwarding signal to ${targetFingerprint}`);
    if (this.#server) {
      return this.#server.forwardSignal(
        this.#fingerprint,
        targetFingerprint,
        signal,
      );
    }
    if (this.#ws) {
      // Real WS path: server-side relay does the routing. We optimistically
      // return true; the server reports `error` asynchronously if the
      // target is offline.
      this.#sendWs({
        type: 'signal',
        from: this.#fingerprint,
        to: targetFingerprint,
        signal,
      });
      return true;
    }
    return false;
  }

  // -- Event Registration ---------------------------------------------------

  /**
   * Register a callback for incoming signals from other peers.
   * Callback receives (fromFingerprint, signal).
   *
   * @param {Function} cb
   */
  onSignal(cb) {
    this.#signalCallbacks.push(cb);
  }

  /**
   * Register a callback for peer presence announcements.
   * Callback receives ({ fingerprint, capabilities }).
   *
   * @param {Function} cb
   */
  onPeerAnnounce(cb) {
    this.#peerAnnounceCallbacks.push(cb);
  }

  /**
   * Register a callback for when the relay connection is established.
   *
   * @param {Function} cb
   */
  onConnect(cb) {
    this.#connectCallbacks.push(cb);
  }

  /**
   * Register a callback for when the relay connection is closed.
   *
   * @param {Function} cb
   */
  onDisconnect(cb) {
    this.#disconnectCallbacks.push(cb);
  }

  /**
   * Register a callback for relay errors.
   *
   * @param {Function} cb
   */
  onError(cb) {
    this.#errorCallbacks.push(cb);
  }

  // -- Serialization --------------------------------------------------------

  /**
   * Serialize to a JSON-safe object (no callbacks/handles).
   *
   * @returns {object}
   */
  toJSON() {
    return {
      relayUrl: this.#relayUrl,
      fingerprint: this.#fingerprint,
      connected: this.connected,
      state: this.#state,
      capabilities: [...this._announcedCapabilities],
      knownPeerCount: this.#knownPeerCount,
    };
  }

  // -- Internal (used by MockRelayServer) -----------------------------------

  /**
   * Deliver an incoming signal from another peer.
   * Called by MockRelayServer.forwardSignal().
   *
   * @param {string} fromFingerprint
   * @param {*} signal
   */
  _deliverSignal(fromFingerprint, signal) {
    this.#fire(this.#signalCallbacks, fromFingerprint, signal);
  }

  /**
   * Deliver a peer presence announcement.
   * Called by MockRelayServer.broadcastPresence().
   *
   * @param {{ fingerprint: string, capabilities: string[] }} info
   */
  _deliverPeerAnnounce(info) {
    this.#fire(this.#peerAnnounceCallbacks, info);
  }

  // -- Private Helpers ------------------------------------------------------

  /**
   * Assert the client is connected. Throws if not.
   */
  #assertConnected() {
    if (this.#state !== 'connected') {
      throw new Error('Not connected to relay');
    }
  }

  /**
   * Fire all callbacks in a list, swallowing listener errors.
   *
   * @param {Function[]} callbacks
   * @param {...*} args
   */
  #fire(callbacks, ...args) {
    for (const cb of callbacks) {
      try {
        cb(...args);
      } catch {
        /* listener errors do not propagate */
      }
    }
  }
}

export { RELAY_STATES };
