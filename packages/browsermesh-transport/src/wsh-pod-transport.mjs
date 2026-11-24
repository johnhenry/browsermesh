/**
 * wsh-pod-transport.mjs -- a `Pod` TransportAdapter over wsh links.
 *
 * Implements the contract in `@johnhenry/browsermesh-pod`'s `transport.mjs`
 * (`send(msg)`, `onMessage(handler)`, `open()`, `close()`, `ready`) on top of
 * `WshPeerLinks`, so a `Pod` uses it with no change:
 *
 *     const identity = await PodIdentity.generate()
 *     const transport = new WshPodTransport({ identity, relays: ['wss://relay.example/'],
 *       authorize: (peer) => registry.knows(peer.podId), peers: [otherPodId] })
 *     await pod.boot({ identity, transport })
 *
 * The sender of an inbound message is the authenticated key of the link it
 * arrived on, never a field of the message: `from` is set to it, and a message
 * whose own `from` or `podId` names another pod is dropped (`foreign-sender`).
 *
 * `send(msg)` goes to the link named by `msg.to`, or to every link for a
 * broadcast (`to` absent or `'*'`). It never throws and never returns a
 * rejecting promise; a message it cannot send (no link, queue full) is dropped
 * and reported as a `dropped` event.
 *
 * No static import of `@johnhenry/browsermesh-pod`: the contract is duck-typed.
 */

import { WshPeerLinks } from './wsh-links.mjs';

const POD_GOODBYE = 'pod:goodbye';
const EVENTS = ['peer-up', 'peer-down', 'refused', 'error', 'dropped'];

export class WshPodTransport {
  #links;
  #owns;
  #handler = null;
  #ready = false;
  #closed = false;
  #peers;
  #awaitPeers;
  #goodbyeOnDown;
  #cbs = Object.fromEntries(EVENTS.map((e) => [e, []]));
  #unsubs = [];

  /**
   * @param {object} opts - `WshPeerLinks` options (`identity`, `relays`, `authorize`, ...), plus:
   * @param {WshPeerLinks} [opts.links] - Use an existing hub (it is not closed by `close()`).
   * @param {string[]} [opts.peers] - Pod ids to link to on `open()`; they are redialled when the link is lost.
   * @param {boolean} [opts.awaitPeers=false] - `open()` waits for the first attempt at each of `peers` to finish.
   * @param {boolean} [opts.goodbyeOnDown=true] - Hand the pod a `pod:goodbye` when a peer's link goes away, so it forgets the peer.
   */
  constructor({ links, peers = [], awaitPeers = false, goodbyeOnDown = true, ...hubOpts } = {}) {
    this.#owns = !links;
    this.#links = links ?? new WshPeerLinks(hubOpts);
    this.#peers = [...peers];
    this.#awaitPeers = awaitPeers;
    this.#goodbyeOnDown = goodbyeOnDown;
    const l = this.#links;
    this.#unsubs.push(
      l.on('message', (m) => this.#onData(m)),
      l.on('peer-up', (e) => this.#fire('peer-up', e)),
      l.on('peer-down', (e) => {
        this.#fire('peer-down', e);
        if (this.#goodbyeOnDown && this.#handler && !this.#closed) this.#deliver({ type: POD_GOODBYE, podId: e.podId, from: e.podId, ts: Date.now(), synthetic: true });
      }),
      l.on('refused', (e) => this.#fire('refused', e)),
      l.on('error', (e) => this.#fire('error', e)),
      l.on('dropped', (e) => this.#fire('dropped', e)),
    );
  }

  /** The hub, for `connect(podId)`, `peers()` and the like. */
  get links() { return this.#links; }

  get ready() { return this.#ready; }

  /** @param {(msg: object) => void} handler */
  onMessage(handler) { this.#handler = handler; }

  /** Events: `peer-up`, `peer-down`, `refused`, `error`, `dropped` (`{ from, reason }`). */
  on(event, cb) {
    if (!EVENTS.includes(event)) throw new Error(`Unknown event: ${event}`);
    this.#cbs[event].push(cb);
  }

  async open() {
    if (this.#ready) return;
    if (this.#closed) throw new Error('WshPodTransport is closed');
    await this.#links.listen();
    this.#ready = true;
    const attempts = this.#peers.map((p) => this.#links.connect(p).catch((error) => { this.#fire('error', { error, podId: p }); }));
    if (this.#awaitPeers) await Promise.allSettled(attempts);
  }

  /** @param {object} msg */
  send(msg) {
    if (!this.#ready || !msg || typeof msg !== 'object') return;
    const to = msg.to;
    if (to && to !== '*') {
      if (!this.#links.isConnected(to)) { this.#fire('dropped', { to, reason: 'no-link' }); return; }
      this.#push(to, msg);
      return;
    }
    for (const peer of this.#links.peers()) this.#push(peer, msg);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready = false;
    for (const off of this.#unsubs) off();
    this.#unsubs = [];
    if (this.#owns) await this.#links.close();
  }

  // -- internals ----------------------------------------------------------

  #push(peer, msg) {
    this.#links.send(peer, msg).catch((err) => this.#fire('dropped', { to: peer, reason: err?.code ?? 'send-failed' }));
  }

  #fire(event, data) {
    for (const cb of [...this.#cbs[event]]) {
      try { cb(data); } catch { /* listener errors do not propagate */ }
    }
  }

  #onData({ from, data }) {
    if (this.#closed) return;
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      this.#fire('dropped', { from, reason: 'not-json' });
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.#fire('dropped', { from, reason: 'not-a-message' });
      return;
    }
    // The sender is the key the session authenticated. A message that claims
    // otherwise is not delivered under either name.
    for (const field of ['from', 'podId']) {
      if (field in msg && msg[field] !== from) {
        this.#fire('dropped', { from, reason: 'foreign-sender', field });
        return;
      }
    }
    this.#deliver({ ...msg, from });
  }

  #deliver(msg) {
    if (!this.#handler) return;
    try { this.#handler(msg); } catch { /* a throwing handler does not break the link */ }
  }
}
