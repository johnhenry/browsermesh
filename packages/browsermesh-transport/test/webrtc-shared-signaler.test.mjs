// Run with: node --import ./test/_setup-globals.mjs --test test/webrtc-shared-signaler.test.mjs
//
// One signaling client serves every negotiation a pod has in flight, and it
// hands each answer / ICE candidate to every listener together with the
// sender's podId. A WebRTCTransport must act only on messages from its own
// remote peer: with three pods, a pod negotiating with two peers at once
// otherwise applied one peer's answer to the other peer's RTCPeerConnection
// (clawser#223: one link one-way, one pod with no sessions).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WebRTCTransport } from '../src/websocket.mjs';

/** Multi-listener signaler shaped like browsermesh-core's SignalingClient. */
class SharedSignaler {
  constructor() { this.listeners = { answer: new Set(), 'ice-candidate': new Set(), offer: new Set() }; this.sent = []; }
  sendOffer(to, offer) { this.sent.push({ type: 'offer', to, offer }); }
  sendAnswer(to, answer) { this.sent.push({ type: 'answer', to, answer }); }
  sendIceCandidate(to, candidate) { this.sent.push({ type: 'ice', to, candidate }); }
  #on(ev, cb) { this.listeners[ev].add(cb); return () => this.listeners[ev].delete(cb); }
  onOffer(cb) { return this.#on('offer', cb); }
  onAnswer(cb) { return this.#on('answer', cb); }
  onIceCandidate(cb) { return this.#on('ice-candidate', cb); }
  // Like SignalingClient#fire: wrapped envelope + the server-stamped sender.
  deliver(ev, payload, from) {
    for (const cb of [...this.listeners[ev]]) cb({ type: ev, source: from, ...payload }, from);
  }
  get count() { return Object.values(this.listeners).reduce((n, s) => n + s.size, 0); }
}

class MockChannel {
  constructor(label) { this.label = label; this.readyState = 'connecting'; this.l = {}; }
  addEventListener(e, cb) { (this.l[e] ||= []).push(cb); }
  removeEventListener(e, cb) { this.l[e] = (this.l[e] || []).filter((f) => f !== cb); }
  open() { this.readyState = 'open'; (this.l.open || []).forEach((cb) => cb({})); }
  send() {}
  close() { this.readyState = 'closed'; }
}

let nextOfferId = 0;
/** Strict like a real RTCPeerConnection: an answer must match this pc's offer, and only once. */
class StrictPC {
  constructor() { this.l = {}; this.channels = []; this.candidates = []; this.signalingState = 'stable'; this.offerId = null; this.appliedAnswers = []; this.connectionState = 'new'; }
  addEventListener(e, cb) { (this.l[e] ||= []).push(cb); }
  removeEventListener() {}
  createDataChannel(label) { const c = new MockChannel(label); this.channels.push(c); return c; }
  async createOffer() { this.offerId = ++nextOfferId; return { type: 'offer', sdp: `offer-${this.offerId}` }; }
  async createAnswer() { return { type: 'answer', sdp: `answer-to-${this.remoteOfferSdp}` }; }
  async setLocalDescription(d) { if (d.type === 'offer') this.signalingState = 'have-local-offer'; }
  async setRemoteDescription(d) {
    if (d.type === 'answer') {
      if (this.signalingState !== 'have-local-offer') throw new Error(`Failed to set remote answer sdp: Called in wrong state: ${this.signalingState}`);
      if (d.sdp !== `answer-to-offer-${this.offerId}`) throw new Error('Failed to set remote answer sdp: answer does not match this connection\'s offer');
      this.signalingState = 'stable';
      this.appliedAnswers.push(d);
    } else {
      this.remoteOfferSdp = d.sdp;
    }
  }
  async addIceCandidate(c) { this.candidates.push(c); }
  close() { this.connectionState = 'closed'; }
}

const make = (signaler, remotePodId, pcs) => new WebRTCTransport({
  localPodId: 'pod-a',
  remotePodId,
  signaler,
  _RTCPeerConnection: class extends StrictPC { constructor(c) { super(c); pcs[remotePodId] = this; } },
});

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('WebRTCTransport on a signaler shared by several negotiations', () => {
  it('two concurrent offers: each answer reaches only its own connection, whichever arrives first', async () => {
    const signaler = new SharedSignaler();
    const pcs = {};
    const toB = make(signaler, 'pod-b', pcs);
    const toC = make(signaler, 'pod-c', pcs);
    const pB = toB.connect();
    const pC = toC.connect();
    await tick();

    // C answers first. Before the fix this was applied to B's pc as well.
    signaler.deliver('answer', { answer: { type: 'answer', sdp: `answer-to-offer-${pcs['pod-c'].offerId}` } }, 'pod-c');
    pcs['pod-c'].channels[0].open();
    signaler.deliver('answer', { answer: { type: 'answer', sdp: `answer-to-offer-${pcs['pod-b'].offerId}` } }, 'pod-b');
    pcs['pod-b'].channels[0].open();

    await Promise.all([pB, pC]);
    assert.equal(toB.connected, true);
    assert.equal(toC.connected, true);
    assert.equal(pcs['pod-b'].appliedAnswers.length, 1);
    assert.equal(pcs['pod-c'].appliedAnswers.length, 1);
  });

  it('ICE candidates from another peer are not fed to this connection (offerer and answerer roles)', async () => {
    const signaler = new SharedSignaler();
    const pcs = {};
    const toB = make(signaler, 'pod-b', pcs);
    const fromC = make(signaler, 'pod-c', pcs);
    const pB = toB.connect();
    fromC.handleOffer({ type: 'offer', sdp: 'offer-from-c' }).catch(() => {});
    await tick();

    signaler.deliver('ice-candidate', { candidate: { candidate: 'from-b' } }, 'pod-b');
    signaler.deliver('ice-candidate', { candidate: { candidate: 'from-c' } }, 'pod-c');
    await tick();
    assert.deepEqual(pcs['pod-b'].candidates.map((c) => c.candidate), ['from-b']);
    assert.deepEqual(pcs['pod-c'].candidates.map((c) => c.candidate), ['from-c']);

    signaler.deliver('answer', { answer: { type: 'answer', sdp: `answer-to-offer-${pcs['pod-b'].offerId}` } }, 'pod-b');
    pcs['pod-b'].channels[0].open();
    await pB;
  });

  it('a duplicate answer is not applied to a connection that already has one', async () => {
    const signaler = new SharedSignaler();
    const pcs = {};
    const toB = make(signaler, 'pod-b', pcs);
    const pB = toB.connect();
    await tick();
    const answer = { answer: { type: 'answer', sdp: `answer-to-offer-${pcs['pod-b'].offerId}` } };
    signaler.deliver('answer', answer, 'pod-b');
    signaler.deliver('answer', answer, 'pod-b');
    pcs['pod-b'].channels[0].open();
    await pB;
    assert.equal(toB.connected, true, 'the repeat did not knock a connected transport back to disconnected');
    assert.equal(pcs['pod-b'].appliedAnswers.length, 1);
  });

  it('close() removes the transport\'s listeners from the shared signaler', async () => {
    const signaler = new SharedSignaler();
    const pcs = {};
    const toB = make(signaler, 'pod-b', pcs);
    const pB = toB.connect();
    await tick();
    signaler.deliver('answer', { answer: { type: 'answer', sdp: `answer-to-offer-${pcs['pod-b'].offerId}` } }, 'pod-b');
    pcs['pod-b'].channels[0].open();
    await pB;
    assert.ok(signaler.count > 0, 'still listening for ICE while connected');
    await toB.close();
    assert.equal(signaler.count, 0, 'nothing left subscribed after close');
  });

  it('a signaler that does not name the sender is still honoured (two-party channels)', async () => {
    const signaler = new SharedSignaler();
    const pcs = {};
    const toB = make(signaler, 'pod-b', pcs);
    const pB = toB.connect();
    await tick();
    // no sender argument at all
    for (const cb of [...signaler.listeners.answer]) cb({ answer: { type: 'answer', sdp: `answer-to-offer-${pcs['pod-b'].offerId}` } });
    for (const cb of [...signaler.listeners['ice-candidate']]) cb({ candidate: { candidate: 'anon' } });
    pcs['pod-b'].channels[0].open();
    await pB;
    await tick();
    assert.equal(pcs['pod-b'].candidates.length, 1);
  });
});
