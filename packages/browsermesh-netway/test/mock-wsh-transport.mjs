/**
 * Mock WSH transport for gateway backend testing.
 * Captures sent messages and allows injecting responses.
 */

export class MockWshTransport {
  #sent = [];
  #onGateway = null;
  connected = true;

  /** Messages sent via this transport. */
  get sent() { return this.#sent; }

  /** Last message sent. */
  get lastSent() { return this.#sent[this.#sent.length - 1]; }

  /** Find sent messages by type. */
  findSent(type) {
    return this.#sent.filter(m => m.type === type);
  }

  /** Simulate sending a control message (captures it). */
  async sendControl(msg) {
    this.#sent.push(msg);
  }

  /** Set the gateway message handler (mimics WshClient.onGatewayMessage). */
  set onGatewayMessage(handler) {
    this.#onGateway = handler;
  }

  /** Inject a message as if it came from the server. */
  inject(msg) {
    this.#onGateway?.(msg);
  }

  clear() {
    this.#sent.length = 0;
  }
}

/**
 * Mock WshClient that wraps MockWshTransport for gateway backend tests.
 */
export class MockWshClient {
  #transport;
  #state;

  #features;

  /**
   * @param {Object} [opts]
   * @param {boolean} [opts.connected=true]
   * @param {string[]} [opts.features] - what the "host" states, as `hasFeature()` reports it. Empty by default,
   *   like a host from before `gateway-credit` existed.
   */
  constructor({ connected = true, features = [] } = {}) {
    this.#features = features;
    this.#transport = new MockWshTransport();
    this.#state = connected ? 'authenticated' : 'disconnected';
    this.onGatewayMessage = null;
    /** Like WshClient's: called when the transport closes. */
    this.onClose = null;
    this.#transport.onGatewayMessage = (msg) => {
      this.onGatewayMessage?.(msg);
    };
  }

  hasFeature(name) { return this.#features.includes(name); }

  get transport() { return this.#transport; }
  get state() { return this.#state; }
  get sent() { return this.#transport.sent; }
  get lastSent() { return this.#transport.lastSent; }
  findSent(type) { return this.#transport.findSent(type); }

  async sendControl(msg) {
    return this.#transport.sendControl(msg);
  }

  /** Inject a gateway message from "server". */
  inject(msg) {
    this.onGatewayMessage?.(msg);
  }

  setConnected(val) {
    this.#state = val ? 'authenticated' : 'disconnected';
  }

  clear() {
    this.#transport.clear();
  }
}
