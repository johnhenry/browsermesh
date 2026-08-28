import { silentCatch } from './silent-catch.mjs'
// clawser-channel-relay.js — Channel Relay Plugin
//
// Virtual server route for webhooks + BroadcastChannel relay.
// Normalizes inbound messages via createInboundMessage().
// Supports named routes for dispatching webhook payloads.

// ── Helpers ──────────────────────────────────────────────────

let relayCounter = 0;

function generateId() {
  return `relay_${Date.now()}_${++relayCounter}`;
}

// ── ChannelRelay ─────────────────────────────────────────────

/**
 * Virtual webhook server + BroadcastChannel relay.
 * Receives inbound webhooks via handleWebhook() and relays via BroadcastChannel.
 * Supports named routes for dispatching different webhook types.
 */
export class ChannelRelay {
  /** @type {object} */
  config;

  /** @type {boolean} */
  running = false;

  /** @type {Function|null} */
  _callback = null;

  /** @type {object|null} BroadcastChannel instance */
  _bc = null;

  /** @type {Map<string, Function>} named route handlers */
  #routes = new Map();

  /**
   * @param {object} opts
   * @param {number} [opts.port=0] — virtual port (for documentation/config)
   * @param {string} [opts.path='/webhook'] — webhook path
   * @param {string} [opts.bcName='clawser-relay'] — BroadcastChannel name
   */
  constructor(opts = {}) {
    this.config = {
      port: opts.port || 0,
      path: opts.path || '/webhook',
      bcName: opts.bcName || 'clawser-relay',
    };
  }

  // ── Message normalization ───────────────────────────────

  /**
   * Normalize a raw webhook payload into standard inbound message format.
   * @param {object} raw
   * @returns {object} Standard InboundMessage
   */
  createInboundMessage(raw) {
    const senderRaw = raw.sender;
    const senderObj = (typeof senderRaw === 'object' && senderRaw !== null)
      ? senderRaw
      : { id: senderRaw || 'unknown', name: senderRaw || 'Unknown' };

    return {
      id: raw.id || generateId(),
      channel: 'relay',
      channelId: raw.channelId || null,
      sender: {
        id: senderObj.id || 'unknown',
        name: senderObj.name || 'Unknown',
        username: senderObj.username || null,
      },
      content: raw.body || raw.text || raw.content || '',
      attachments: raw.attachments || [],
      replyTo: raw.replyTo || null,
      timestamp: raw.timestamp || Date.now(),
    };
  }

  // ── Lifecycle ───────────────────────────────────────────

  /**
   * Start the relay — creates BroadcastChannel and begins listening.
   */
  start() {
    if (this.running) return;
    this.running = true;

    // Create BroadcastChannel for cross-tab relay
    if (typeof BroadcastChannel !== 'undefined' && !this._bc) {
      try {
        this._bc = new BroadcastChannel(this.config.bcName);
        this._bc.onmessage = (event) => this._handleBcMessage(event);
      } catch {
        // BroadcastChannel not available — proceed without
      }
    }
  }

  /**
   * Stop the relay — closes BroadcastChannel.
   */
  stop() {
    if (!this.running) return;
    this.running = false;

    if (this._bc) {
      try { this._bc.close(); } catch (e) { silentCatch('clawser-channel-relay', 'this._bc.close', e) }
      this._bc = null;
    }
  }

  // ── Inbound handling ────────────────────────────────────

  /**
   * Register a callback for inbound messages.
   * @param {Function} callback — (msg: InboundMessage) => void
   */
  onMessage(callback) {
    this._callback = callback;
  }

  /**
   * Handle an incoming webhook payload.
   * Dispatches to named route if payload has a `route` property,
   * otherwise normalizes and forwards to onMessage callback.
   * @param {object} payload
   */
  handleWebhook(payload) {
    if (!this.running) return;

    // Check for named route
    if (payload.route && this.#routes.has(payload.route)) {
      this.#routes.get(payload.route)(payload);
      return;
    }

    // Normalize and dispatch
    const msg = this.createInboundMessage(payload);
    if (this._callback) {
      this._callback(msg);
    }
  }

  /**
   * Handle a message received from BroadcastChannel.
   * @param {object} event — MessageEvent-like {data: ...}
   */
  _handleBcMessage(event) {
    if (!this.running) return;
    const raw = event.data || event;
    const msg = this.createInboundMessage(raw);
    if (this._callback) {
      this._callback(msg);
    }
  }

  // ── Outbound ────────────────────────────────────────────

  /**
   * Send a message via BroadcastChannel relay.
   * @param {string} text
   * @param {object} [opts]
   * @returns {boolean}
   */
  sendMessage(text, opts = {}) {
    if (!this.running) return false;

    const msg = {
      text,
      channel: 'relay',
      sender: opts.sender || 'clawser',
      timestamp: Date.now(),
    };

    if (this._bc) {
      try {
        this._bc.postMessage(msg);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  // ── Route table ─────────────────────────────────────────

  /**
   * Add a named route handler.
   * @param {string} name
   * @param {Function} handler — (payload) => void
   */
  addRoute(name, handler) {
    this.#routes.set(name, handler);
  }

  /**
   * Remove a named route handler.
   * @param {string} name
   * @returns {boolean}
   */
  removeRoute(name) {
    return this.#routes.delete(name);
  }

  /**
   * Check if a named route exists.
   * @param {string} name
   * @returns {boolean}
   */
  hasRoute(name) {
    return this.#routes.has(name);
  }

  /**
   * List all registered route names.
   * @returns {string[]}
   */
  listRoutes() {
    return [...this.#routes.keys()];
  }
}
