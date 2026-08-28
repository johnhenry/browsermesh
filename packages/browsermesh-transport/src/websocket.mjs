import { silentCatch } from './silent-catch.mjs'
/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-websocket.js -- WebSocket, WebRTC & WebTransport Adapters.
 *
 * Concrete transport implementations for the BrowserMesh transport
 * abstraction layer. Each adapter wraps a browser API (WebSocket,
 * RTCPeerConnection, WebTransport) behind a unified interface with
 * injectable mocks for testability.
 *
 * Also provides NATTraversal helpers and a TransportFactory that
 * negotiates the best available transport for a given peer pair.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-websocket.test.mjs
 */

// ---------------------------------------------------------------------------
// Wire Constants
// ---------------------------------------------------------------------------

export const WS_CONNECT  = 0xC6;
export const WS_MESSAGE  = 0xC7;
export const WS_CLOSE    = 0xC8;
export const WRT_OFFER   = 0xC9;
export const WRT_ANSWER  = 0xCA;
export const WRT_ICE     = 0xCB;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Measure byte length of a value.
 * @param {*} data
 * @returns {number}
 */
function byteLength(data) {
  if (typeof data === 'string') return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof data === 'object') return JSON.stringify(data).length;
  return 0;
}

/** Valid event names for WebSocketTransport */
const WS_EVENTS = Object.freeze(['open', 'message', 'close', 'error', 'reconnect']);

/** Valid event names for WebRTCTransport */
const RTC_EVENTS = Object.freeze(['open', 'message', 'close', 'error', 'ice-candidate']);

/** Valid event names for WebTransportTransport */
const WT_EVENTS = Object.freeze(['open', 'message', 'close', 'error', 'stream']);

// ---------------------------------------------------------------------------
// WebSocketTransport
// ---------------------------------------------------------------------------

/**
 * WebSocket-based mesh transport.
 *
 * Wraps a WebSocket connection with reconnection logic, heartbeat
 * keepalive, and stats tracking. The WebSocket constructor is
 * injectable for testing.
 */
export class WebSocketTransport {
  /** @type {string} */
  #url;

  /** @type {string[]} */
  #protocols;

  /** @type {boolean} */
  #reconnect;

  /** @type {number} */
  #maxReconnectAttempts;

  /** @type {number} */
  #reconnectDelayMs;

  /** @type {number} */
  #heartbeatIntervalMs;

  /** @type {string} */
  #state = 'disconnected';

  /** @type {object|null} */
  #ws = null;

  /** @type {Function} */
  #WebSocketCtor;

  /** @type {number} */
  #reconnectAttempts = 0;

  /** @type {boolean} */
  #userClosed = false;

  /** @type {number|null} */
  #heartbeatTimer = null;

  /** @type {{ open: Function[], message: Function[], close: Function[], error: Function[], reconnect: Function[] }} */
  #callbacks = { open: [], message: [], close: [], error: [], reconnect: [] };

  /** @type {{ messagesSent: number, messagesReceived: number, bytesIn: number, bytesOut: number, reconnects: number, lastPingMs: number }} */
  #stats = { messagesSent: 0, messagesReceived: 0, bytesIn: 0, bytesOut: 0, reconnects: 0, lastPingMs: 0 };

  /**
   * @param {object} opts
   * @param {string} opts.url - WebSocket endpoint URL
   * @param {string[]} [opts.protocols] - Sub-protocols
   * @param {boolean} [opts.reconnect=true] - Enable auto-reconnect
   * @param {number} [opts.maxReconnectAttempts=5] - Max reconnection attempts
   * @param {number} [opts.reconnectDelayMs=1000] - Base delay between reconnects
   * @param {number} [opts.heartbeatIntervalMs=30000] - Heartbeat interval
   * @param {Function} [opts._WebSocket] - Injectable WebSocket constructor
   */
  constructor(opts = {}) {
    if (!opts.url) throw new Error('url is required');
    this.#url = opts.url;
    this.#protocols = opts.protocols || [];
    this.#reconnect = opts.reconnect !== undefined ? opts.reconnect : true;
    this.#maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
    this.#reconnectDelayMs = opts.reconnectDelayMs ?? 1000;
    this.#heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 30000;
    this.#WebSocketCtor = opts._WebSocket || globalThis.WebSocket;
  }

  // -- Getters ---------------------------------------------------------------

  /** Transport type identifier. */
  get type() { return 'wsh-ws'; }

  /** Current connection state. */
  get state() { return this.#state; }

  /** True when transport is in 'connected' state. */
  get connected() { return this.#state === 'connected'; }

  /** WebSocket endpoint URL. */
  get url() { return this.#url; }

  /** Number of reconnection attempts since last successful connect. */
  get reconnectAttempts() { return this.#reconnectAttempts; }

  /** Whether auto-reconnect is enabled. */
  get reconnectEnabled() { return this.#reconnect; }

  /** Heartbeat interval in ms. */
  get heartbeatIntervalMs() { return this.#heartbeatIntervalMs; }

  // -- Public API ------------------------------------------------------------

  /**
   * Open a WebSocket connection.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.#state === 'connected' || this.#state === 'connecting') {
      throw new Error('Already connected or connecting');
    }
    this.#userClosed = false;
    this.#state = 'connecting';

    return new Promise((resolve, reject) => {
      try {
        this.#ws = new this.#WebSocketCtor(this.#url, this.#protocols.length ? this.#protocols : undefined);
      } catch (err) {
        this.#state = 'disconnected';
        return reject(err);
      }

      const onOpen = () => {
        cleanup();
        this.#state = 'connected';
        this.#reconnectAttempts = 0;
        this._startHeartbeat();
        this._fireEvent('open');
        this.#ws.addEventListener('message', this.#onMessage);
        this.#ws.addEventListener('close', this.#onClose);
        this.#ws.addEventListener('error', this.#onError);
        resolve();
      };

      const onError = (err) => {
        cleanup();
        this.#state = 'disconnected';
        this._fireEvent('error', err);
        reject(err instanceof Error ? err : new Error('WebSocket connection failed'));
      };

      const cleanup = () => {
        this.#ws.removeEventListener('open', onOpen);
        this.#ws.removeEventListener('error', onError);
      };

      this.#ws.addEventListener('open', onOpen);
      this.#ws.addEventListener('error', onError);
    });
  }

  /**
   * Send data over the WebSocket.
   * @param {*} data
   */
  send(data) {
    if (!this.connected) throw new Error('Not connected');
    this.#ws.send(data);
    this.#stats.messagesSent++;
    this.#stats.bytesOut += byteLength(data);
  }

  /**
   * Close the WebSocket connection gracefully.
   * @param {number} [code]
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async close(code, reason) {
    if (this.#state === 'closed' || this.#state === 'disconnected') return;
    this.#userClosed = true;
    this.#state = 'closing';
    this._stopHeartbeat();

    if (this.#ws) {
      return new Promise((resolve) => {
        const onClose = () => {
          this.#ws.removeEventListener('close', onClose);
          this.#state = 'closed';
          this._fireEvent('close');
          resolve();
        };
        this.#ws.addEventListener('close', onClose);
        // Remove our general close handler so it doesn't double-fire
        this.#ws.removeEventListener('close', this.#onClose);
        this.#ws.close(code, reason);
      });
    }
    this.#state = 'closed';
    this._fireEvent('close');
  }

  /**
   * Register an event listener.
   * @param {string} event - One of: 'open', 'message', 'close', 'error', 'reconnect'
   * @param {Function} cb
   */
  on(event, cb) {
    if (!WS_EVENTS.includes(event)) throw new Error(`Unknown event: ${event}`);
    this.#callbacks[event].push(cb);
  }

  /**
   * Get transport statistics.
   * @returns {{ messagesSent: number, messagesReceived: number, bytesIn: number, bytesOut: number, reconnects: number, lastPingMs: number }}
   */
  getStats() {
    return { ...this.#stats };
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      type: this.type,
      state: this.#state,
      url: this.#url,
      reconnectAttempts: this.#reconnectAttempts,
      stats: this.getStats(),
    };
  }

  // -- Internal event handlers (arrow fns for stable `this`) -----------------

  /** @type {(ev: { data: * }) => void} */
  #onMessage = (ev) => {
    const data = ev.data;
    this.#stats.messagesReceived++;
    this.#stats.bytesIn += byteLength(data);
    this._fireEvent('message', data);
  };

  /** @type {(ev: { code: number, reason: string }) => void} */
  #onClose = (ev) => {
    this._stopHeartbeat();
    if (this.#userClosed) {
      this.#state = 'closed';
      this._fireEvent('close', ev);
      return;
    }
    // Unexpected close — attempt reconnect
    this.#state = 'disconnected';
    this._fireEvent('close', ev);
    if (this.#reconnect) {
      this._handleReconnect();
    }
  };

  /** @type {(err: *) => void} */
  #onError = (err) => {
    this._fireEvent('error', err);
  };

  // -- Internal methods ------------------------------------------------------

  /**
   * Fire all callbacks for a given event.
   * @param {string} event
   * @param {*} [data]
   */
  _fireEvent(event, data) {
    for (const cb of this.#callbacks[event] || []) {
      try { cb(data); } catch (e) { silentCatch('clawser-mesh-websocket', 'swallow-listener-errors', e) }
    }
  }

  /**
   * Attempt to reconnect with exponential backoff.
   */
  async _handleReconnect() {
    if (this.#reconnectAttempts >= this.#maxReconnectAttempts) {
      // Reconnect budget exhausted — surface a clear error to the user
      // so the UI doesn't silently sit at "disconnected" after 5 retries.
      this._fireEvent('error', new Error(
        `WebSocket reconnect failed after ${this.#maxReconnectAttempts} attempts (giving up)`,
      ));
      return;
    }

    this.#reconnectAttempts++;
    this.#stats.reconnects++;
    this._fireEvent('reconnect', { attempt: this.#reconnectAttempts });

    const delay = this.#reconnectDelayMs * Math.pow(2, this.#reconnectAttempts - 1);
    await new Promise(r => setTimeout(r, delay));

    if (this.#userClosed) return;

    try {
      await this.connect();
    } catch (err) {
      // connect() failed — retry until budget exhausted, then surface.
      if (this.#reconnect && this.#reconnectAttempts < this.#maxReconnectAttempts) {
        this._handleReconnect();
      } else {
        this._fireEvent('error', err instanceof Error ? err : new Error(
          `WebSocket reconnect failed: ${err?.message || err}`,
        ));
      }
    }
  }

  /**
   * Start heartbeat ping interval.
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (!this.connected || !this.#ws) return;
      const ping = JSON.stringify({ type: 'ping', ts: Date.now() });
      try {
        this.#ws.send(ping);
        this.#stats.lastPingMs = Date.now();
      } catch (e) { silentCatch('clawser-mesh-websocket', 'ignore-send-errors-during-heartbeat', e) }
    }, this.#heartbeatIntervalMs);
  }

  /**
   * Stop heartbeat interval.
   */
  _stopHeartbeat() {
    if (this.#heartbeatTimer != null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// WebRTCTransport
// ---------------------------------------------------------------------------

/**
 * WebRTC data channel transport.
 *
 * Establishes a peer connection using an external signaler for
 * offer/answer exchange and ICE candidate trickle. The RTCPeerConnection
 * constructor is injectable for testing.
 */
export class WebRTCTransport {
  /** @type {string} */
  #localPodId;

  /** @type {string} */
  #remotePodId;

  /** @type {object} */
  #signaler;

  /** @type {object} */
  #config;

  /** @type {Function} */
  #RTCPeerConnectionCtor;

  /** @type {string} */
  #state = 'disconnected';

  /** @type {object|null} */
  #pc = null;

  /** @type {object|null} */
  #dataChannel = null;

  /** @type {{ open: Function[], message: Function[], close: Function[], error: Function[], 'ice-candidate': Function[] }} */
  #callbacks = { open: [], message: [], close: [], error: [], 'ice-candidate': [] };

  /** @type {{ messagesSent: number, messagesReceived: number, bytesIn: number, bytesOut: number, iceState: string }} */
  #stats = { messagesSent: 0, messagesReceived: 0, bytesIn: 0, bytesOut: 0, iceState: 'new' };

  /**
   * @param {object} opts
   * @param {string} opts.localPodId - Local pod identifier
   * @param {string} opts.remotePodId - Remote pod identifier
   * @param {object} opts.signaler - Signaling channel
   * @param {object} [opts.config] - RTCConfiguration
   * @param {Function} [opts._RTCPeerConnection] - Injectable constructor
   */
  constructor(opts = {}) {
    if (!opts.localPodId) throw new Error('localPodId is required');
    if (!opts.remotePodId) throw new Error('remotePodId is required');
    if (!opts.signaler) throw new Error('signaler is required');
    this.#localPodId = opts.localPodId;
    this.#remotePodId = opts.remotePodId;
    this.#signaler = opts.signaler;
    this.#config = opts.config || {};
    this.#RTCPeerConnectionCtor = opts._RTCPeerConnection || globalThis.RTCPeerConnection;
  }

  // -- Getters ---------------------------------------------------------------

  /** Transport type identifier. */
  get type() { return 'webrtc'; }

  /** Current connection state. */
  get state() { return this.#state; }

  /** True when transport is in 'connected' state. */
  get connected() { return this.#state === 'connected'; }

  /** Local pod identifier. */
  get localPodId() { return this.#localPodId; }

  /** Remote pod identifier. */
  get remotePodId() { return this.#remotePodId; }

  // -- Public API ------------------------------------------------------------

  /**
   * Connect as the offerer: create data channel, SDP offer, and wait
   * for answer + data channel open.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.#state === 'connected' || this.#state === 'connecting') {
      throw new Error('Already connected or connecting');
    }
    this.#state = 'connecting';

    this.#pc = new this.#RTCPeerConnectionCtor(this.#config);

    // Listen for local ICE candidates
    this.#pc.addEventListener('icecandidate', (ev) => {
      if (ev.candidate) {
        this.#signaler.sendIceCandidate(this.#remotePodId, ev.candidate);
        this._fireEvent('ice-candidate', ev.candidate);
      }
    });

    // Listen for connection state changes
    this.#pc.addEventListener('connectionstatechange', () => {
      this.#stats.iceState = this.#pc.iceConnectionState || 'unknown';
      if (this.#pc.connectionState === 'failed' || this.#pc.connectionState === 'closed') {
        if (this.#state !== 'closed' && this.#state !== 'closing') {
          this.#state = 'closed';
          this._fireEvent('close');
        }
      }
    });

    // Set up signaler listeners for remote ICE candidates
    this.#signaler.onIceCandidate((candidate) => {
      if (this.#pc) {
        this.#pc.addIceCandidate(candidate);
      }
    });

    // Create data channel and offer
    this.#dataChannel = this.#pc.createDataChannel('mesh', { ordered: true });
    this._attachDataChannelListeners(this.#dataChannel);

    const offer = await this.#pc.createOffer();
    await this.#pc.setLocalDescription(offer);
    await this.#signaler.sendOffer(this.#remotePodId, offer);

    // Wait for answer from remote
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('WebRTC answer timeout'));
      }, 30000);

      this.#signaler.onAnswer(async (answer) => {
        clearTimeout(timeout);
        try {
          await this.#pc.setRemoteDescription(answer);
        } catch (err) {
          this.#state = 'disconnected';
          reject(err);
          return;
        }
        // Wait for data channel to open
        if (this.#dataChannel.readyState === 'open') {
          this.#state = 'connected';
          this._fireEvent('open');
          resolve();
        } else {
          const onDCOpen = () => {
            this.#dataChannel.removeEventListener('open', onDCOpen);
            this.#state = 'connected';
            this._fireEvent('open');
            resolve();
          };
          this.#dataChannel.addEventListener('open', onDCOpen);
        }
      });
    });
  }

  /**
   * Handle an incoming offer (answerer role).
   * @param {object} offer - SDP offer
   * @returns {Promise<void>}
   */
  async handleOffer(offer) {
    if (!this.#pc) {
      this.#pc = new this.#RTCPeerConnectionCtor(this.#config);
    }
    this.#state = 'connecting';

    await this.#pc.setRemoteDescription(offer);
    const answer = await this.#pc.createAnswer();
    await this.#pc.setLocalDescription(answer);
    await this.#signaler.sendAnswer(this.#remotePodId, answer);

    // The data channel will arrive via ondatachannel event
    this.#pc.addEventListener('datachannel', (ev) => {
      this.#dataChannel = ev.channel;
      this._attachDataChannelListeners(this.#dataChannel);
      if (this.#dataChannel.readyState === 'open') {
        this.#state = 'connected';
        this._fireEvent('open');
      }
    });
  }

  /**
   * Send data over the data channel.
   * @param {*} data
   */
  send(data) {
    if (!this.connected || !this.#dataChannel) throw new Error('Not connected');
    this.#dataChannel.send(data);
    this.#stats.messagesSent++;
    this.#stats.bytesOut += byteLength(data);
  }

  /**
   * Close the peer connection.
   * @returns {Promise<void>}
   */
  async close() {
    this.#state = 'closing';
    if (this.#dataChannel) {
      try { this.#dataChannel.close(); } catch (e) { silentCatch('clawser-mesh-websocket', 'this', e) }
    }
    if (this.#pc) {
      this.#pc.close();
    }
    this.#state = 'closed';
    this._fireEvent('close');
  }

  /**
   * Register an event listener.
   * @param {string} event - One of: 'open', 'message', 'close', 'error', 'ice-candidate'
   * @param {Function} cb
   */
  on(event, cb) {
    if (!RTC_EVENTS.includes(event)) throw new Error(`Unknown event: ${event}`);
    this.#callbacks[event].push(cb);
  }

  /**
   * Get transport statistics.
   * @returns {{ messagesSent: number, messagesReceived: number, bytesIn: number, bytesOut: number, iceState: string }}
   */
  getStats() {
    return { ...this.#stats };
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      type: this.type,
      state: this.#state,
      localPodId: this.#localPodId,
      remotePodId: this.#remotePodId,
      stats: this.getStats(),
    };
  }

  // -- Internal --------------------------------------------------------------

  /**
   * Attach event listeners to a data channel.
   * @param {object} dc
   */
  _attachDataChannelListeners(dc) {
    dc.addEventListener('open', () => {
      if (this.#state === 'connecting') {
        this.#state = 'connected';
        this._fireEvent('open');
      }
    });

    dc.addEventListener('message', (ev) => {
      const data = ev.data;
      this.#stats.messagesReceived++;
      this.#stats.bytesIn += byteLength(data);
      this._fireEvent('message', data);
    });

    dc.addEventListener('close', () => {
      if (this.#state !== 'closed' && this.#state !== 'closing') {
        this.#state = 'closed';
        this._fireEvent('close');
      }
    });
  }

  /**
   * Fire all callbacks for a given event.
   * @param {string} event
   * @param {*} [data]
   */
  _fireEvent(event, data) {
    for (const cb of this.#callbacks[event] || []) {
      try { cb(data); } catch (e) { silentCatch('clawser-mesh-websocket', 'swallow-listener-errors', e) }
    }
  }
}

// ---------------------------------------------------------------------------
// WebTransportTransport
// ---------------------------------------------------------------------------

/**
 * WebTransport (HTTP/3) based mesh transport.
 *
 * Uses datagrams for unreliable messaging and bidirectional streams
 * for reliable ordered communication. The WebTransport constructor
 * is injectable for testing.
 */
export class WebTransportTransport {
  /** @type {string} */
  #url;

  /** @type {object[]} */
  #serverCertificateHashes;

  /** @type {string} */
  #state = 'disconnected';

  /** @type {object|null} */
  #transport = null;

  /** @type {object|null} */
  #writer = null;

  /** @type {Function} */
  #WebTransportCtor;

  /** @type {{ open: Function[], message: Function[], close: Function[], error: Function[], stream: Function[] }} */
  #callbacks = { open: [], message: [], close: [], error: [], stream: [] };

  /** @type {{ messagesSent: number, messagesReceived: number, bytesIn: number, bytesOut: number, streams: number }} */
  #stats = { messagesSent: 0, messagesReceived: 0, bytesIn: 0, bytesOut: 0, streams: 0 };

  /**
   * @param {object} opts
   * @param {string} opts.url - WebTransport endpoint URL
   * @param {object[]} [opts.serverCertificateHashes] - Certificate hashes
   * @param {Function} [opts._WebTransport] - Injectable constructor
   */
  constructor(opts = {}) {
    if (!opts.url) throw new Error('url is required');
    this.#url = opts.url;
    this.#serverCertificateHashes = opts.serverCertificateHashes || [];
    this.#WebTransportCtor = opts._WebTransport || globalThis.WebTransport;
  }

  // -- Getters ---------------------------------------------------------------

  /** Transport type identifier. */
  get type() { return 'wsh-wt'; }

  /** Current connection state. */
  get state() { return this.#state; }

  /** True when transport is in 'connected' state. */
  get connected() { return this.#state === 'connected'; }

  /** WebTransport endpoint URL. */
  get url() { return this.#url; }

  // -- Public API ------------------------------------------------------------

  /**
   * Establish a WebTransport session.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.#state === 'connected' || this.#state === 'connecting') {
      throw new Error('Already connected or connecting');
    }
    this.#state = 'connecting';

    const opts = {};
    if (this.#serverCertificateHashes.length > 0) {
      opts.serverCertificateHashes = this.#serverCertificateHashes;
    }

    try {
      this.#transport = new this.#WebTransportCtor(this.#url, opts);
      await this.#transport.ready;
    } catch (err) {
      this.#state = 'disconnected';
      throw err;
    }

    this.#writer = this.#transport.datagrams.writable.getWriter();
    this.#state = 'connected';
    this._fireEvent('open');

    // Listen for session close
    this.#transport.closed.then(() => {
      if (this.#state !== 'closed' && this.#state !== 'closing') {
        this.#state = 'closed';
        this._fireEvent('close');
      }
    }).catch(() => {
      if (this.#state !== 'closed') {
        this.#state = 'closed';
        this._fireEvent('error', new Error('WebTransport session closed unexpectedly'));
        this._fireEvent('close');
      }
    });
  }

  /**
   * Send data via datagram.
   * @param {*} data
   * @returns {Promise<void>}
   */
  async send(data) {
    if (!this.connected) throw new Error('Not connected');
    const encoded = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data;
    await this.#writer.write(encoded);
    this.#stats.messagesSent++;
    this.#stats.bytesOut += byteLength(data);
  }

  /**
   * Close the WebTransport session.
   * @returns {Promise<void>}
   */
  async close() {
    if (this.#state === 'closed' || this.#state === 'disconnected') return;
    this.#state = 'closing';
    if (this.#writer) {
      try { await this.#writer.close(); } catch (e) { silentCatch('clawser-mesh-websocket', 'this', e) }
    }
    if (this.#transport) {
      try { this.#transport.close(); } catch (e) { silentCatch('clawser-mesh-websocket', 'this', e) }
    }
    this.#state = 'closed';
    this._fireEvent('close');
  }

  /**
   * Create a new bidirectional stream.
   * @returns {Promise<{ readable: ReadableStream, writable: WritableStream }>}
   */
  async createStream() {
    if (!this.connected) throw new Error('Not connected');
    const stream = await this.#transport.createBidirectionalStream();
    this.#stats.streams++;
    this._fireEvent('stream', stream);
    return stream;
  }

  /**
   * Register an event listener.
   * @param {string} event - One of: 'open', 'message', 'close', 'error', 'stream'
   * @param {Function} cb
   */
  on(event, cb) {
    if (!WT_EVENTS.includes(event)) throw new Error(`Unknown event: ${event}`);
    this.#callbacks[event].push(cb);
  }

  /**
   * Get transport statistics.
   * @returns {{ messagesSent: number, messagesReceived: number, bytesIn: number, bytesOut: number, streams: number }}
   */
  getStats() {
    return { ...this.#stats };
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      type: this.type,
      state: this.#state,
      url: this.#url,
      stats: this.getStats(),
    };
  }

  // -- Internal --------------------------------------------------------------

  /**
   * Fire all callbacks for a given event.
   * @param {string} event
   * @param {*} [data]
   */
  _fireEvent(event, data) {
    for (const cb of this.#callbacks[event] || []) {
      try { cb(data); } catch (e) { silentCatch('clawser-mesh-websocket', 'swallow-listener-errors', e) }
    }
  }
}

// ---------------------------------------------------------------------------
// NATTraversal
// ---------------------------------------------------------------------------

/**
 * NAT traversal helper.
 *
 * Provides STUN/TURN server configuration and NAT type detection
 * heuristics for WebRTC connectivity.
 */
export class NATTraversal {
  /** @type {string[]} */
  #stunServers;

  /** @type {object[]} */
  #turnServers;

  /** @type {string} */
  #natType = 'unknown';

  /**
   * @param {object} [opts]
   * @param {string[]} [opts.stunServers] - STUN server URLs
   * @param {object[]} [opts.turnServers] - TURN server configs with urls, username, credential
   */
  constructor(opts = {}) {
    this.#stunServers = opts.stunServers || ['stun:stun.l.google.com:19302'];
    this.#turnServers = opts.turnServers || [];
  }

  /**
   * Attempt to determine the public address using STUN.
   *
   * In a browser environment this would use an RTCPeerConnection to
   * gather reflexive candidates. Returns a placeholder when unavailable.
   *
   * @returns {Promise<{ address: string, port: number, type: string }>}
   */
  async getPublicAddress() {
    // In a real implementation, we would create an RTCPeerConnection,
    // gather candidates, and parse the srflx candidate. For now, return
    // a placeholder indicating the API shape.
    return { address: '0.0.0.0', port: 0, type: 'unknown' };
  }

  /**
   * Request a TURN relay allocation.
   *
   * In a real implementation this would use the TURN protocol to
   * allocate a relay address. Returns a placeholder.
   *
   * @param {object} turnServer - { urls, username, credential }
   * @returns {Promise<{ relayAddress: string, relayPort: number, lifetime: number }>}
   */
  async createRelayAllocation(turnServer) {
    return {
      relayAddress: '0.0.0.0',
      relayPort: 0,
      lifetime: 600,
    };
  }

  /**
   * Get the detected NAT type.
   *
   * @returns {'full-cone'|'restricted'|'port-restricted'|'symmetric'|'unknown'}
   */
  getNATType() {
    return this.#natType;
  }

  /**
   * Format ICE servers for RTCConfiguration.
   *
   * @returns {Array<{ urls: string|string[], username?: string, credential?: string }>}
   */
  getIceServers() {
    const servers = [];
    for (const stun of this.#stunServers) {
      servers.push({ urls: stun });
    }
    for (const turn of this.#turnServers) {
      servers.push({
        urls: turn.urls,
        username: turn.username,
        credential: turn.credential,
      });
    }
    return servers;
  }
}

// ---------------------------------------------------------------------------
// TransportFactory
// ---------------------------------------------------------------------------

/**
 * Factory for creating transport instances.
 *
 * Detects browser support for each transport type and provides a
 * negotiation method that tries transports in preference order.
 */
export class TransportFactory {
  /** @type {string[]} */
  #preferredOrder;

  /** @type {NATTraversal|null} */
  #natTraversal;

  /** @type {Function|null} */
  #WebSocketCtor;

  /** @type {Function|null} */
  #RTCPeerConnectionCtor;

  /** @type {Function|null} */
  #WebTransportCtor;

  /**
   * @param {object} [opts]
   * @param {string[]} [opts.preferredOrder] - Transport preference order
   * @param {NATTraversal} [opts.natTraversal] - NAT traversal helper
   * @param {Function} [opts._WebSocket] - Injectable WebSocket constructor
   * @param {Function} [opts._RTCPeerConnection] - Injectable RTCPeerConnection constructor
   * @param {Function} [opts._WebTransport] - Injectable WebTransport constructor
   */
  constructor(opts = {}) {
    this.#preferredOrder = opts.preferredOrder || ['webrtc', 'wsh-wt', 'wsh-ws'];
    this.#natTraversal = opts.natTraversal || null;
    this.#WebSocketCtor = opts._WebSocket !== undefined ? opts._WebSocket : (globalThis.WebSocket || null);
    this.#RTCPeerConnectionCtor = opts._RTCPeerConnection !== undefined ? opts._RTCPeerConnection : (globalThis.RTCPeerConnection || null);
    this.#WebTransportCtor = opts._WebTransport !== undefined ? opts._WebTransport : (globalThis.WebTransport || null);
  }

  /** Current preferred transport order (copy). */
  get preferredOrder() {
    return [...this.#preferredOrder];
  }

  /**
   * Create a transport instance of the specified type.
   *
   * @param {string} type - 'webrtc', 'wsh-wt', or 'wsh-ws'
   * @param {object} opts - Options passed to the transport constructor
   * @returns {Promise<WebSocketTransport|WebRTCTransport|WebTransportTransport>}
   */
  async create(type, opts) {
    switch (type) {
      case 'wsh-ws':
        return new WebSocketTransport({
          ...opts,
          _WebSocket: this.#WebSocketCtor,
        });
      case 'webrtc':
        return new WebRTCTransport({
          ...opts,
          _RTCPeerConnection: this.#RTCPeerConnectionCtor,
        });
      case 'wsh-wt':
        return new WebTransportTransport({
          ...opts,
          _WebTransport: this.#WebTransportCtor,
        });
      default:
        throw new Error(`Unknown transport type: ${type}`);
    }
  }

  /**
   * Detect which transport types are supported in the current
   * environment.
   *
   * @returns {string[]}
   */
  getSupportedTypes() {
    const types = [];
    if (this.#RTCPeerConnectionCtor) types.push('webrtc');
    if (this.#WebTransportCtor) types.push('wsh-wt');
    if (this.#WebSocketCtor) types.push('wsh-ws');
    return types;
  }

  /**
   * Negotiate the best transport for a peer pair.
   *
   * Tries each transport type in preference order. Returns the first
   * successfully created (but not yet connected) transport.
   *
   * @param {string} localPodId
   * @param {string} remotePodId
   * @param {object} signaler
   * @param {object} endpointOpts - Map of type -> constructor options
   * @returns {Promise<WebSocketTransport|WebRTCTransport|WebTransportTransport>}
   */
  async negotiate(localPodId, remotePodId, signaler, endpointOpts = {}) {
    const errors = [];
    const supported = this.getSupportedTypes();

    for (const type of this.#preferredOrder) {
      if (!supported.includes(type)) continue;
      const opts = endpointOpts[type];
      if (!opts) continue;

      try {
        const transport = await this.create(type, {
          ...opts,
          signaler,
          localPodId,
          remotePodId,
        });
        return transport;
      } catch (e) {
        errors.push({ type, error: e.message });
      }
    }
    throw new Error(`All transports failed: ${JSON.stringify(errors)}`);
  }
}
