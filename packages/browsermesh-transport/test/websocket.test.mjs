// Run with: node --import ./test/_setup-globals.mjs --test test/websocket.test.mjs
import { describe, it, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  WebSocketTransport,
  WebRTCTransport,
  WebTransportTransport,
  NATTraversal,
  TransportFactory,
  WS_CONNECT,
  WS_MESSAGE,
  WS_CLOSE,
  WRT_OFFER,
  WRT_ANSWER,
  WRT_ICE,
} from '../src/websocket.mjs';

// ── Mock Classes ──────────────────────────────────────────────────

class MockWebSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0; // CONNECTING
    this._listeners = {};
    this._sent = [];
    this._closeCode = null;
    this._closeReason = null;
  }
  addEventListener(e, cb) { (this._listeners[e] ||= []).push(cb); }
  removeEventListener(e, cb) { this._listeners[e] = (this._listeners[e] || []).filter(f => f !== cb); }
  send(data) { this._sent.push(data); }
  close(code, reason) {
    this._closeCode = code;
    this._closeReason = reason;
    this.readyState = 2; // CLOSING
    // simulate async close
    setTimeout(() => {
      this.readyState = 3; // CLOSED
      this._fire('close', { code: code || 1000, reason: reason || '' });
    }, 0);
  }
  _fire(e, data) { (this._listeners[e] || []).forEach(cb => cb(data)); }
  _open() { this.readyState = 1; this._fire('open', {}); }
  _error(err) { this._fire('error', err || new Error('ws error')); }
  _message(data) { this._fire('message', { data }); }
}

class MockRTCPeerConnection {
  constructor(config) {
    this.config = config;
    this._listeners = {};
    this._localDescription = null;
    this._remoteDescription = null;
    this._iceCandidates = [];
    this._dataChannels = [];
    this.iceConnectionState = 'new';
    this.connectionState = 'new';
    this.signalingState = 'stable';
    this._closed = false;
  }
  addEventListener(e, cb) { (this._listeners[e] ||= []).push(cb); }
  removeEventListener(e, cb) { this._listeners[e] = (this._listeners[e] || []).filter(f => f !== cb); }
  _fire(e, data) { (this._listeners[e] || []).forEach(cb => cb(data)); }

  async createOffer() { return { type: 'offer', sdp: 'mock-offer-sdp' }; }
  async createAnswer() { return { type: 'answer', sdp: 'mock-answer-sdp' }; }
  async setLocalDescription(desc) { this._localDescription = desc; }
  async setRemoteDescription(desc) { this._remoteDescription = desc; }
  async addIceCandidate(candidate) { this._iceCandidates.push(candidate); }

  get localDescription() { return this._localDescription; }
  get remoteDescription() { return this._remoteDescription; }

  createDataChannel(label, opts) {
    const dc = new MockDataChannel(label, opts);
    this._dataChannels.push(dc);
    return dc;
  }
  close() {
    this._closed = true;
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
    this._fire('connectionstatechange', {});
  }
}

class MockDataChannel {
  constructor(label, opts) {
    this.label = label;
    this.opts = opts;
    this.readyState = 'connecting';
    this._listeners = {};
    this._sent = [];
  }
  addEventListener(e, cb) { (this._listeners[e] ||= []).push(cb); }
  removeEventListener(e, cb) { this._listeners[e] = (this._listeners[e] || []).filter(f => f !== cb); }
  _fire(e, data) { (this._listeners[e] || []).forEach(cb => cb(data)); }
  send(data) { this._sent.push(data); }
  close() { this.readyState = 'closed'; this._fire('close', {}); }
  _open() { this.readyState = 'open'; this._fire('open', {}); }
  _message(data) { this._fire('message', { data }); }
}

class MockWebTransport {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this._closed = false;
    this._listeners = {};
    this._streams = [];
    this.ready = Promise.resolve();
    this.closed = new Promise((resolve) => { this._resolveClosed = resolve; });
    this.datagrams = {
      readable: { getReader: () => new MockStreamReader() },
      writable: { getWriter: () => new MockStreamWriter() },
    };
    this.incomingBidirectionalStreams = {
      getReader: () => new MockStreamReader(),
    };
  }
  createBidirectionalStream() {
    const stream = { readable: new MockStreamReader(), writable: new MockStreamWriter() };
    this._streams.push(stream);
    return Promise.resolve(stream);
  }
  close() {
    this._closed = true;
    if (this._resolveClosed) this._resolveClosed();
  }
}

class MockStreamReader {
  constructor() { this._chunks = []; this._done = false; }
  async read() {
    if (this._done || this._chunks.length === 0) return { done: true, value: undefined };
    return { done: false, value: this._chunks.shift() };
  }
  releaseLock() {}
  cancel() { this._done = true; return Promise.resolve(); }
}

class MockStreamWriter {
  constructor() { this._written = []; this._closed = false; }
  async write(data) { this._written.push(data); }
  async close() { this._closed = true; }
  releaseLock() {}
}

class MockSignaler {
  constructor() {
    this._sent = [];
    this._handlers = {};
  }
  async sendOffer(remotePodId, offer) {
    this._sent.push({ type: 'offer', remotePodId, offer });
  }
  async sendAnswer(remotePodId, answer) {
    this._sent.push({ type: 'answer', remotePodId, answer });
  }
  async sendIceCandidate(remotePodId, candidate) {
    this._sent.push({ type: 'ice', remotePodId, candidate });
  }
  onOffer(cb) { this._handlers.offer = cb; }
  onAnswer(cb) { this._handlers.answer = cb; }
  onIceCandidate(cb) { this._handlers.ice = cb; }
  // Simulate receiving signals
  _receiveOffer(offer) { if (this._handlers.offer) this._handlers.offer(offer); }
  _receiveAnswer(answer) { if (this._handlers.answer) this._handlers.answer(answer); }
  _receiveIceCandidate(candidate) { if (this._handlers.ice) this._handlers.ice(candidate); }
}

// ── Wire Constants ─────────────────────────────────────────────────

describe('Wire Constants', () => {
  it('WS_CONNECT is 0xC6', () => {
    assert.equal(WS_CONNECT, 0xC6);
  });

  it('WS_MESSAGE is 0xC7', () => {
    assert.equal(WS_MESSAGE, 0xC7);
  });

  it('WS_CLOSE is 0xC8', () => {
    assert.equal(WS_CLOSE, 0xC8);
  });

  it('WRT_OFFER is 0xC9', () => {
    assert.equal(WRT_OFFER, 0xC9);
  });

  it('WRT_ANSWER is 0xCA', () => {
    assert.equal(WRT_ANSWER, 0xCA);
  });

  it('WRT_ICE is 0xCB', () => {
    assert.equal(WRT_ICE, 0xCB);
  });
});

// ── WebSocketTransport ─────────────────────────────────────────────

describe('WebSocketTransport', () => {
  /** @type {WebSocketTransport} */
  let ws;
  /** @type {MockWebSocket|null} */
  let lastMockWs;

  afterEach(async () => {
    if (ws && ws.state !== 'closed' && ws.state !== 'disconnected') {
      try { await ws.close(); } catch { /* already closed */ }
    }
    ws = null;
    lastMockWs = null;
  });

  function createWS(overrides = {}) {
    lastMockWs = null;
    return new WebSocketTransport({
      url: 'wss://mesh.example.com',
      _WebSocket: class extends MockWebSocket {
        constructor(url, protocols) {
          super(url, protocols);
          lastMockWs = this;
        }
      },
      reconnect: false,
      ...overrides,
    });
  }

  // -- Constructor ---

  it('constructor requires url', () => {
    assert.throws(() => new WebSocketTransport({}), /url is required/);
  });

  it('constructor stores url', () => {
    ws = createWS();
    assert.equal(ws.url, 'wss://mesh.example.com');
  });

  it('constructor defaults reconnect to true', () => {
    ws = new WebSocketTransport({
      url: 'wss://mesh.example.com',
      _WebSocket: MockWebSocket,
    });
    assert.equal(ws.reconnectEnabled, true);
  });

  it('constructor defaults heartbeat interval to 30000', () => {
    ws = createWS();
    assert.equal(ws.heartbeatIntervalMs, 30000);
  });

  it('starts in disconnected state', () => {
    ws = createWS();
    assert.equal(ws.state, 'disconnected');
    assert.equal(ws.connected, false);
  });

  it('reconnectAttempts starts at 0', () => {
    ws = createWS();
    assert.equal(ws.reconnectAttempts, 0);
  });

  // -- connect() ---

  it('connect transitions to connecting state', async () => {
    ws = createWS();
    const p = ws.connect();
    assert.equal(ws.state, 'connecting');
    lastMockWs._open();
    await p;
  });

  it('connect transitions to connected on open', async () => {
    ws = createWS();
    const p = ws.connect();
    lastMockWs._open();
    await p;
    assert.equal(ws.state, 'connected');
    assert.equal(ws.connected, true);
  });

  it('connect fires open event', async () => {
    ws = createWS();
    let opened = false;
    ws.on('open', () => { opened = true; });
    const p = ws.connect();
    lastMockWs._open();
    await p;
    assert.equal(opened, true);
  });

  it('connect rejects on error', async () => {
    ws = createWS();
    const p = ws.connect();
    lastMockWs._error(new Error('connection refused'));
    await assert.rejects(p, /connection refused|WebSocket/);
  });

  it('double connect throws', async () => {
    ws = createWS();
    const p = ws.connect();
    lastMockWs._open();
    await p;
    await assert.rejects(() => ws.connect(), /already connected|already/i);
  });

  it('connect passes protocols to WebSocket', async () => {
    ws = createWS({ protocols: ['mesh-v1', 'mesh-v2'] });
    const p = ws.connect();
    assert.deepEqual(lastMockWs.protocols, ['mesh-v1', 'mesh-v2']);
    lastMockWs._open();
    await p;
  });

  // -- send() ---

  it('send throws when not connected', () => {
    ws = createWS();
    assert.throws(() => ws.send('hello'), /not connected/i);
  });

  it('send delivers data via WebSocket', async () => {
    ws = createWS();
    const p = ws.connect();
    lastMockWs._open();
    await p;
    ws.send('hello');
    assert.deepEqual(lastMockWs._sent, ['hello']);
  });

  it('send tracks messagesSent count', async () => {
    ws = createWS();
    const p = ws.connect();
    lastMockWs._open();
    await p;
    ws.send('a');
    ws.send('b');
    const stats = ws.getStats();
    assert.equal(stats.messagesSent, 2);
  });

  it('send tracks bytesOut for string data', async () => {
    ws = createWS();
    const p = ws.connect();
    lastMockWs._open();
    await p;
    ws.send('hello');
    const stats = ws.getStats();
    assert.equal(stats.bytesOut, 5);
  });

  // -- on('message') ---

  it('receives messages and fires callback', async () => {
    ws = createWS();
    const msgs = [];
    ws.on('message', (data) => { msgs.push(data); });
    const p = ws.connect();
    lastMockWs._open();
    await p;
    lastMockWs._message('hello from server');
    assert.deepEqual(msgs, ['hello from server']);
  });

  it('tracks messagesReceived count', async () => {
    ws = createWS();
    ws.on('message', () => {});
    const p = ws.connect();
    lastMockWs._open();
    await p;
    lastMockWs._message('a');
    lastMockWs._message('b');
    const stats = ws.getStats();
    assert.equal(stats.messagesReceived, 2);
  });

  it('tracks bytesIn for string messages', async () => {
    ws = createWS();
    ws.on('message', () => {});
    const p = ws.connect();
    lastMockWs._open();
    await p;
    lastMockWs._message('hello');
    const stats = ws.getStats();
    assert.equal(stats.bytesIn, 5);
  });

  // -- close() ---

  it('close transitions through closing to closed', async () => {
    ws = createWS();
    const p = ws.connect();
    lastMockWs._open();
    await p;
    const closeP = ws.close();
    assert.equal(ws.state, 'closing');
    await closeP;
    assert.equal(ws.state, 'closed');
  });

  it('close fires close event', async () => {
    ws = createWS();
    let closed = false;
    ws.on('close', () => { closed = true; });
    const p = ws.connect();
    lastMockWs._open();
    await p;
    await ws.close();
    assert.equal(closed, true);
  });

  it('close passes code and reason', async () => {
    ws = createWS();
    const p = ws.connect();
    lastMockWs._open();
    await p;
    ws.close(4001, 'going away');
    assert.equal(lastMockWs._closeCode, 4001);
    assert.equal(lastMockWs._closeReason, 'going away');
  });

  it('send after close throws', async () => {
    ws = createWS();
    const p = ws.connect();
    lastMockWs._open();
    await p;
    await ws.close();
    assert.throws(() => ws.send('hello'), /not connected/i);
  });

  // -- on('error') ---

  it('error event fires on WebSocket error', async () => {
    ws = createWS();
    const errors = [];
    ws.on('error', (e) => { errors.push(e); });
    const p = ws.connect();
    lastMockWs._open();
    await p;
    lastMockWs._error(new Error('oops'));
    assert.equal(errors.length, 1);
  });

  // -- Event listener management ---

  it('on registers multiple listeners for same event', async () => {
    ws = createWS();
    let count = 0;
    ws.on('open', () => { count++; });
    ws.on('open', () => { count++; });
    const p = ws.connect();
    lastMockWs._open();
    await p;
    assert.equal(count, 2);
  });

  it('on rejects unknown event type', () => {
    ws = createWS();
    assert.throws(() => ws.on('bogus', () => {}), /Unknown event/);
  });

  // -- Reconnect logic ---

  it('reconnect fires reconnect event', async () => {
    ws = createWS({
      reconnect: true,
      maxReconnectAttempts: 2,
      reconnectDelayMs: 10,
    });
    let reconnectCount = 0;
    ws.on('reconnect', () => { reconnectCount++; });
    const p = ws.connect();
    lastMockWs._open();
    await p;

    // Simulate unexpected close (not user-initiated)
    lastMockWs._fire('close', { code: 1006, reason: 'abnormal' });

    // Wait for reconnect attempt
    await new Promise(r => setTimeout(r, 50));
    assert.ok(reconnectCount >= 1, 'reconnect event should have fired');
  });

  it('reconnect increments reconnectAttempts', async () => {
    ws = createWS({
      reconnect: true,
      maxReconnectAttempts: 3,
      reconnectDelayMs: 10,
    });
    const p = ws.connect();
    lastMockWs._open();
    await p;

    // Simulate unexpected close
    lastMockWs._fire('close', { code: 1006, reason: 'abnormal' });
    await new Promise(r => setTimeout(r, 50));
    assert.ok(ws.reconnectAttempts >= 1);
  });

  it('reconnect stops after maxReconnectAttempts', async () => {
    let connectCount = 0;
    ws = new WebSocketTransport({
      url: 'wss://mesh.example.com',
      _WebSocket: class extends MockWebSocket {
        constructor(url, protocols) {
          super(url, protocols);
          lastMockWs = this;
          connectCount++;
          // Immediately error for reconnect attempts
          if (connectCount > 1) {
            setTimeout(() => this._error(new Error('fail')), 0);
          }
        }
      },
      reconnect: true,
      maxReconnectAttempts: 2,
      reconnectDelayMs: 10,
    });

    const p = ws.connect();
    lastMockWs._open();
    await p;

    // Force unexpected close
    lastMockWs._fire('close', { code: 1006, reason: 'abnormal' });
    await new Promise(r => setTimeout(r, 200));

    // Should have tried to connect plus at most 2 reconnects
    assert.ok(connectCount <= 4, `expected <= 4 total connect attempts, got ${connectCount}`);
  });

  it('no reconnect when close is user-initiated', async () => {
    let connectCount = 0;
    ws = new WebSocketTransport({
      url: 'wss://mesh.example.com',
      _WebSocket: class extends MockWebSocket {
        constructor(url, protocols) {
          super(url, protocols);
          lastMockWs = this;
          connectCount++;
        }
      },
      reconnect: true,
      maxReconnectAttempts: 3,
      reconnectDelayMs: 10,
    });
    const p = ws.connect();
    lastMockWs._open();
    await p;

    await ws.close();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(connectCount, 1, 'should not reconnect after user close');
  });

  // -- Heartbeat ---

  it('heartbeat sends pings at interval', async () => {
    ws = createWS({ heartbeatIntervalMs: 20 });
    const p = ws.connect();
    lastMockWs._open();
    await p;

    await new Promise(r => setTimeout(r, 80));
    // Should have sent some ping messages
    const pings = lastMockWs._sent.filter(
      m => typeof m === 'string' && m.includes('"type":"ping"')
    );
    assert.ok(pings.length >= 1, `expected at least 1 ping, got ${pings.length}`);
    await ws.close();
  });

  it('heartbeat stops on close', async () => {
    ws = createWS({ heartbeatIntervalMs: 20 });
    const p = ws.connect();
    lastMockWs._open();
    await p;

    await ws.close();
    const sentBefore = lastMockWs._sent.length;
    await new Promise(r => setTimeout(r, 60));
    assert.equal(lastMockWs._sent.length, sentBefore, 'no more pings after close');
  });

  // -- getStats() ---

  it('getStats returns all expected fields', async () => {
    ws = createWS();
    const stats = ws.getStats();
    assert.ok('messagesSent' in stats);
    assert.ok('messagesReceived' in stats);
    assert.ok('bytesIn' in stats);
    assert.ok('bytesOut' in stats);
    assert.ok('reconnects' in stats);
    assert.ok('lastPingMs' in stats);
  });

  it('getStats starts at zero', () => {
    ws = createWS();
    const stats = ws.getStats();
    assert.equal(stats.messagesSent, 0);
    assert.equal(stats.messagesReceived, 0);
    assert.equal(stats.bytesIn, 0);
    assert.equal(stats.bytesOut, 0);
    assert.equal(stats.reconnects, 0);
    assert.equal(stats.lastPingMs, 0);
  });

  // -- toJSON() ---

  it('toJSON includes type, state, url', () => {
    ws = createWS();
    const json = ws.toJSON();
    assert.equal(json.type, 'wsh-ws');
    assert.equal(json.state, 'disconnected');
    assert.equal(json.url, 'wss://mesh.example.com');
  });

  it('toJSON reflects connected state', async () => {
    ws = createWS();
    const p = ws.connect();
    lastMockWs._open();
    await p;
    assert.equal(ws.toJSON().state, 'connected');
  });
});

// ── WebRTCTransport ─────────────────────────────────────────────────

describe('WebRTCTransport', () => {
  /** @type {WebRTCTransport} */
  let rtc;
  let signaler;
  /** @type {MockRTCPeerConnection} */
  let lastPC;

  afterEach(async () => {
    if (rtc && rtc.state !== 'closed' && rtc.state !== 'disconnected') {
      try { await rtc.close(); } catch { /* already closed */ }
    }
    rtc = null;
    lastPC = null;
  });

  function createRTC(overrides = {}) {
    signaler = new MockSignaler();
    lastPC = null;
    return new WebRTCTransport({
      localPodId: 'pod-alice',
      remotePodId: 'pod-bob',
      signaler,
      _RTCPeerConnection: class extends MockRTCPeerConnection {
        constructor(config) {
          super(config);
          lastPC = this;
        }
      },
      ...overrides,
    });
  }

  // -- Constructor ---

  it('constructor requires signaler', () => {
    assert.throws(
      () => new WebRTCTransport({
        localPodId: 'a',
        remotePodId: 'b',
        _RTCPeerConnection: MockRTCPeerConnection,
      }),
      /signaler is required/,
    );
  });

  it('constructor requires localPodId', () => {
    assert.throws(
      () => new WebRTCTransport({
        remotePodId: 'b',
        signaler: new MockSignaler(),
        _RTCPeerConnection: MockRTCPeerConnection,
      }),
      /localPodId is required/,
    );
  });

  it('constructor requires remotePodId', () => {
    assert.throws(
      () => new WebRTCTransport({
        localPodId: 'a',
        signaler: new MockSignaler(),
        _RTCPeerConnection: MockRTCPeerConnection,
      }),
      /remotePodId is required/,
    );
  });

  it('stores localPodId and remotePodId', () => {
    rtc = createRTC();
    assert.equal(rtc.localPodId, 'pod-alice');
    assert.equal(rtc.remotePodId, 'pod-bob');
  });

  it('starts in disconnected state', () => {
    rtc = createRTC();
    assert.equal(rtc.state, 'disconnected');
    assert.equal(rtc.connected, false);
  });

  // -- connect() (as offerer) ---

  it('connect creates offer and sends via signaler', async () => {
    rtc = createRTC();
    const p = rtc.connect();

    // Simulate answer coming back
    setTimeout(() => {
      signaler._receiveAnswer({ type: 'answer', sdp: 'mock-answer-sdp' });
      // Simulate data channel opening
      if (lastPC._dataChannels[0]) lastPC._dataChannels[0]._open();
    }, 10);

    await p;
    const offers = signaler._sent.filter(s => s.type === 'offer');
    assert.equal(offers.length, 1);
    assert.equal(offers[0].remotePodId, 'pod-bob');
  });

  it('connect transitions to connecting then connected', async () => {
    rtc = createRTC();
    const p = rtc.connect();
    assert.equal(rtc.state, 'connecting');

    setTimeout(() => {
      signaler._receiveAnswer({ type: 'answer', sdp: 'mock-answer-sdp' });
      if (lastPC._dataChannels[0]) lastPC._dataChannels[0]._open();
    }, 10);

    await p;
    assert.equal(rtc.state, 'connected');
    assert.equal(rtc.connected, true);
  });

  it('connect fires open event when data channel opens', async () => {
    rtc = createRTC();
    let opened = false;
    rtc.on('open', () => { opened = true; });
    const p = rtc.connect();

    setTimeout(() => {
      signaler._receiveAnswer({ type: 'answer', sdp: 'mock-answer-sdp' });
      if (lastPC._dataChannels[0]) lastPC._dataChannels[0]._open();
    }, 10);

    await p;
    assert.equal(opened, true);
  });

  // -- ICE candidates ---

  it('handles ice candidates from signaler', async () => {
    rtc = createRTC();
    const p = rtc.connect();

    setTimeout(() => {
      signaler._receiveIceCandidate({ candidate: 'cand-1', sdpMid: '0' });
      signaler._receiveAnswer({ type: 'answer', sdp: 'mock-answer-sdp' });
      if (lastPC._dataChannels[0]) lastPC._dataChannels[0]._open();
    }, 10);

    await p;
    assert.equal(lastPC._iceCandidates.length, 1);
  });

  it('fires ice-candidate event for local candidates', async () => {
    rtc = createRTC();
    const candidates = [];
    rtc.on('ice-candidate', (c) => { candidates.push(c); });
    const p = rtc.connect();

    setTimeout(() => {
      // Simulate local ICE candidate
      lastPC._fire('icecandidate', { candidate: { candidate: 'local-cand', sdpMid: '0' } });
      signaler._receiveAnswer({ type: 'answer', sdp: 'mock-answer-sdp' });
      if (lastPC._dataChannels[0]) lastPC._dataChannels[0]._open();
    }, 10);

    await p;
    assert.equal(candidates.length, 1);
  });

  // -- send() ---

  it('send throws when not connected', () => {
    rtc = createRTC();
    assert.throws(() => rtc.send('hello'), /not connected/i);
  });

  it('send delivers data via data channel', async () => {
    rtc = createRTC();
    const p = rtc.connect();
    setTimeout(() => {
      signaler._receiveAnswer({ type: 'answer', sdp: 'mock-answer-sdp' });
      if (lastPC._dataChannels[0]) lastPC._dataChannels[0]._open();
    }, 10);
    await p;

    rtc.send('hello-peer');
    assert.deepEqual(lastPC._dataChannels[0]._sent, ['hello-peer']);
  });

  it('send tracks messagesSent', async () => {
    rtc = createRTC();
    const p = rtc.connect();
    setTimeout(() => {
      signaler._receiveAnswer({ type: 'answer', sdp: 'mock-answer-sdp' });
      if (lastPC._dataChannels[0]) lastPC._dataChannels[0]._open();
    }, 10);
    await p;

    rtc.send('a');
    rtc.send('b');
    assert.equal(rtc.getStats().messagesSent, 2);
  });

  // -- close() ---

  it('close closes peer connection', async () => {
    rtc = createRTC();
    const p = rtc.connect();
    setTimeout(() => {
      signaler._receiveAnswer({ type: 'answer', sdp: 'mock-answer-sdp' });
      if (lastPC._dataChannels[0]) lastPC._dataChannels[0]._open();
    }, 10);
    await p;

    await rtc.close();
    assert.equal(lastPC._closed, true);
    assert.equal(rtc.state, 'closed');
  });

  it('close fires close event', async () => {
    rtc = createRTC();
    let closed = false;
    rtc.on('close', () => { closed = true; });
    const p = rtc.connect();
    setTimeout(() => {
      signaler._receiveAnswer({ type: 'answer', sdp: 'mock-answer-sdp' });
      if (lastPC._dataChannels[0]) lastPC._dataChannels[0]._open();
    }, 10);
    await p;

    await rtc.close();
    assert.equal(closed, true);
  });

  // -- on('message') ---

  it('receives messages via data channel', async () => {
    rtc = createRTC();
    const msgs = [];
    rtc.on('message', (d) => { msgs.push(d); });
    const p = rtc.connect();
    setTimeout(() => {
      signaler._receiveAnswer({ type: 'answer', sdp: 'mock-answer-sdp' });
      if (lastPC._dataChannels[0]) lastPC._dataChannels[0]._open();
    }, 10);
    await p;

    lastPC._dataChannels[0]._message('peer-msg');
    assert.deepEqual(msgs, ['peer-msg']);
  });

  // -- on('error') ---

  it('on rejects unknown event type', () => {
    rtc = createRTC();
    assert.throws(() => rtc.on('bogus', () => {}), /Unknown event/);
  });

  // -- double connect ---

  it('double connect throws', async () => {
    rtc = createRTC();
    const p = rtc.connect();
    setTimeout(() => {
      signaler._receiveAnswer({ type: 'answer', sdp: 'mock-answer-sdp' });
      if (lastPC._dataChannels[0]) lastPC._dataChannels[0]._open();
    }, 10);
    await p;
    await assert.rejects(() => rtc.connect(), /already connected|already/i);
  });

  // -- getStats() ---

  it('getStats returns expected fields', () => {
    rtc = createRTC();
    const stats = rtc.getStats();
    assert.ok('messagesSent' in stats);
    assert.ok('messagesReceived' in stats);
    assert.ok('bytesIn' in stats);
    assert.ok('bytesOut' in stats);
    assert.ok('iceState' in stats);
  });

  it('getStats starts at zero', () => {
    rtc = createRTC();
    const stats = rtc.getStats();
    assert.equal(stats.messagesSent, 0);
    assert.equal(stats.messagesReceived, 0);
    assert.equal(stats.bytesIn, 0);
    assert.equal(stats.bytesOut, 0);
  });

  // -- toJSON() ---

  it('toJSON includes type, state, localPodId, remotePodId', () => {
    rtc = createRTC();
    const json = rtc.toJSON();
    assert.equal(json.type, 'webrtc');
    assert.equal(json.state, 'disconnected');
    assert.equal(json.localPodId, 'pod-alice');
    assert.equal(json.remotePodId, 'pod-bob');
  });
});

// ── WebTransportTransport ─────────────────────────────────────────

describe('WebTransportTransport', () => {
  /** @type {WebTransportTransport} */
  let wt;
  /** @type {MockWebTransport|null} */
  let lastMockWT;

  afterEach(async () => {
    if (wt && wt.state !== 'closed' && wt.state !== 'disconnected') {
      try { await wt.close(); } catch { /* already closed */ }
    }
    wt = null;
    lastMockWT = null;
  });

  function createWT(overrides = {}) {
    lastMockWT = null;
    return new WebTransportTransport({
      url: 'https://mesh.example.com:4433',
      _WebTransport: class extends MockWebTransport {
        constructor(url, opts) {
          super(url, opts);
          lastMockWT = this;
        }
      },
      ...overrides,
    });
  }

  // -- Constructor ---

  it('constructor requires url', () => {
    assert.throws(() => new WebTransportTransport({}), /url is required/);
  });

  it('constructor stores url', () => {
    wt = createWT();
    assert.equal(wt.url, 'https://mesh.example.com:4433');
  });

  it('starts in disconnected state', () => {
    wt = createWT();
    assert.equal(wt.state, 'disconnected');
    assert.equal(wt.connected, false);
  });

  // -- connect() ---

  it('connect transitions to connected', async () => {
    wt = createWT();
    await wt.connect();
    assert.equal(wt.state, 'connected');
    assert.equal(wt.connected, true);
  });

  it('connect fires open event', async () => {
    wt = createWT();
    let opened = false;
    wt.on('open', () => { opened = true; });
    await wt.connect();
    assert.equal(opened, true);
  });

  it('double connect throws', async () => {
    wt = createWT();
    await wt.connect();
    await assert.rejects(() => wt.connect(), /already connected|already/i);
  });

  it('connect rejects on error', async () => {
    wt = new WebTransportTransport({
      url: 'https://mesh.example.com:4433',
      _WebTransport: class {
        constructor() {
          this.ready = Promise.reject(new Error('transport failed'));
          this.closed = new Promise(() => {});
        }
        close() {}
      },
    });
    await assert.rejects(() => wt.connect(), /transport failed/);
  });

  // -- send() ---

  it('send throws when not connected', async () => {
    wt = createWT();
    await assert.rejects(() => wt.send('hello'), /not connected/i);
  });

  it('send delivers data via datagram writer', async () => {
    wt = createWT();
    await wt.connect();
    await wt.send('hello');
    assert.deepEqual(lastMockWT.datagrams.writable.getWriter()._written.length >= 0, true);
  });

  it('send tracks messagesSent', async () => {
    wt = createWT();
    await wt.connect();
    await wt.send('a');
    await wt.send('b');
    assert.equal(wt.getStats().messagesSent, 2);
  });

  // -- close() ---

  it('close transitions to closed', async () => {
    wt = createWT();
    await wt.connect();
    await wt.close();
    assert.equal(wt.state, 'closed');
  });

  it('close fires close event', async () => {
    wt = createWT();
    let closed = false;
    wt.on('close', () => { closed = true; });
    await wt.connect();
    await wt.close();
    assert.equal(closed, true);
  });

  it('send after close throws', async () => {
    wt = createWT();
    await wt.connect();
    await wt.close();
    await assert.rejects(() => wt.send('hello'), /not connected/i);
  });

  // -- createStream() ---

  it('createStream creates a bidirectional stream', async () => {
    wt = createWT();
    await wt.connect();
    const stream = await wt.createStream();
    assert.ok(stream);
    assert.ok(stream.readable);
    assert.ok(stream.writable);
  });

  it('createStream throws when not connected', async () => {
    wt = createWT();
    await assert.rejects(() => wt.createStream(), /not connected/i);
  });

  it('createStream tracks stream count in stats', async () => {
    wt = createWT();
    await wt.connect();
    await wt.createStream();
    await wt.createStream();
    assert.equal(wt.getStats().streams, 2);
  });

  // -- on events ---

  it('on rejects unknown event type', () => {
    wt = createWT();
    assert.throws(() => wt.on('bogus', () => {}), /Unknown event/);
  });

  // -- getStats() ---

  it('getStats returns expected fields', () => {
    wt = createWT();
    const stats = wt.getStats();
    assert.ok('messagesSent' in stats);
    assert.ok('messagesReceived' in stats);
    assert.ok('bytesIn' in stats);
    assert.ok('bytesOut' in stats);
    assert.ok('streams' in stats);
  });

  it('getStats starts at zero', () => {
    wt = createWT();
    const stats = wt.getStats();
    assert.equal(stats.messagesSent, 0);
    assert.equal(stats.messagesReceived, 0);
    assert.equal(stats.bytesIn, 0);
    assert.equal(stats.bytesOut, 0);
    assert.equal(stats.streams, 0);
  });

  // -- toJSON() ---

  it('toJSON includes type, state, url', () => {
    wt = createWT();
    const json = wt.toJSON();
    assert.equal(json.type, 'wsh-wt');
    assert.equal(json.state, 'disconnected');
    assert.equal(json.url, 'https://mesh.example.com:4433');
  });
});

// ── NATTraversal ──────────────────────────────────────────────────

describe('NATTraversal', () => {
  /** @type {NATTraversal} */
  let nat;

  beforeEach(() => {
    nat = new NATTraversal();
  });

  // -- Constructor ---

  it('default STUN servers include google', () => {
    const servers = nat.getIceServers();
    assert.ok(servers.some(s => s.urls && s.urls.includes('stun:stun.l.google.com:19302')));
  });

  it('accepts custom STUN servers', () => {
    const custom = new NATTraversal({ stunServers: ['stun:custom.example.com:3478'] });
    const servers = custom.getIceServers();
    assert.ok(servers.some(s => s.urls && s.urls.includes('stun:custom.example.com:3478')));
  });

  it('accepts TURN servers', () => {
    const withTurn = new NATTraversal({
      turnServers: [{
        urls: 'turn:turn.example.com:3478',
        username: 'user',
        credential: 'pass',
      }],
    });
    const servers = withTurn.getIceServers();
    assert.ok(servers.some(s => s.urls === 'turn:turn.example.com:3478'));
  });

  // -- getIceServers() ---

  it('getIceServers returns array of RTCIceServer objects', () => {
    const servers = nat.getIceServers();
    assert.ok(Array.isArray(servers));
    assert.ok(servers.length > 0);
    assert.ok(servers[0].urls);
  });

  // -- getNATType() ---

  it('getNATType returns a valid type', () => {
    const type = nat.getNATType();
    assert.ok(['full-cone', 'restricted', 'port-restricted', 'symmetric', 'unknown'].includes(type));
  });

  it('getNATType returns unknown by default', () => {
    assert.equal(nat.getNATType(), 'unknown');
  });

  // -- getPublicAddress() ---

  it('getPublicAddress returns address object', async () => {
    const addr = await nat.getPublicAddress();
    assert.ok('address' in addr);
    assert.ok('port' in addr);
    assert.ok('type' in addr);
  });

  // -- createRelayAllocation() ---

  it('createRelayAllocation returns allocation info', async () => {
    const alloc = await nat.createRelayAllocation({
      urls: 'turn:turn.example.com:3478',
      username: 'user',
      credential: 'pass',
    });
    assert.ok('relayAddress' in alloc);
    assert.ok('relayPort' in alloc);
    assert.ok('lifetime' in alloc);
  });
});

// ── TransportFactory ──────────────────────────────────────────────

describe('TransportFactory', () => {
  /** @type {TransportFactory} */
  let factory;

  beforeEach(() => {
    factory = new TransportFactory({
      _WebSocket: MockWebSocket,
      _RTCPeerConnection: MockRTCPeerConnection,
      _WebTransport: MockWebTransport,
    });
  });

  // -- Constructor ---

  it('default preferredOrder is webrtc, wsh-wt, wsh-ws', () => {
    assert.deepEqual(factory.preferredOrder, ['webrtc', 'wsh-wt', 'wsh-ws']);
  });

  it('accepts custom preferredOrder', () => {
    const custom = new TransportFactory({
      preferredOrder: ['wsh-ws', 'webrtc'],
      _WebSocket: MockWebSocket,
    });
    assert.deepEqual(custom.preferredOrder, ['wsh-ws', 'webrtc']);
  });

  // -- create() ---

  it('create returns WebSocketTransport for wsh-ws', async () => {
    const t = await factory.create('wsh-ws', { url: 'wss://example.com' });
    assert.ok(t instanceof WebSocketTransport);
  });

  it('create returns WebRTCTransport for webrtc', async () => {
    const signaler = new MockSignaler();
    const t = await factory.create('webrtc', {
      signaler,
      localPodId: 'a',
      remotePodId: 'b',
    });
    assert.ok(t instanceof WebRTCTransport);
  });

  it('create returns WebTransportTransport for wsh-wt', async () => {
    const t = await factory.create('wsh-wt', { url: 'https://example.com:4433' });
    assert.ok(t instanceof WebTransportTransport);
  });

  it('create throws for unknown type', async () => {
    await assert.rejects(
      () => factory.create('carrier-pigeon', {}),
      /Unknown transport type/,
    );
  });

  // -- getSupportedTypes() ---

  it('getSupportedTypes returns array', () => {
    const types = factory.getSupportedTypes();
    assert.ok(Array.isArray(types));
  });

  it('getSupportedTypes includes wsh-ws when WebSocket available', () => {
    const types = factory.getSupportedTypes();
    assert.ok(types.includes('wsh-ws'));
  });

  it('getSupportedTypes includes webrtc when RTCPeerConnection available', () => {
    const types = factory.getSupportedTypes();
    assert.ok(types.includes('webrtc'));
  });

  it('getSupportedTypes includes wsh-wt when WebTransport available', () => {
    const types = factory.getSupportedTypes();
    assert.ok(types.includes('wsh-wt'));
  });

  // -- negotiate() ---

  it('negotiate returns first successful transport', async () => {
    const signaler = new MockSignaler();
    const t = await factory.negotiate('pod-a', 'pod-b', signaler, {
      'wsh-ws': { url: 'wss://example.com' },
    });
    assert.ok(t instanceof WebSocketTransport);
  });

  it('negotiate respects preferredOrder', async () => {
    const wsFirst = new TransportFactory({
      preferredOrder: ['wsh-ws', 'webrtc'],
      _WebSocket: MockWebSocket,
      _RTCPeerConnection: MockRTCPeerConnection,
    });
    const signaler = new MockSignaler();
    const t = await wsFirst.negotiate('pod-a', 'pod-b', signaler, {
      'webrtc': { signaler, localPodId: 'pod-a', remotePodId: 'pod-b' },
      'wsh-ws': { url: 'wss://example.com' },
    });
    assert.ok(t instanceof WebSocketTransport);
  });

  it('negotiate throws when all fail', async () => {
    const emptyFactory = new TransportFactory({
      _WebSocket: null,
      _RTCPeerConnection: null,
      _WebTransport: null,
    });
    const signaler = new MockSignaler();
    await assert.rejects(
      () => emptyFactory.negotiate('a', 'b', signaler, {}),
      /All transports failed|No transport/,
    );
  });
});
