// Wire-encoding contract (browsermesh#208).
//
// RTCDataChannel.send() / WebSocket.send() accept only a string or binary.
// A plain object is not rejected -- it is coerced to the text
// "[object Object]". The mocks elsewhere in this suite just push whatever
// they are given onto an array, so they could never have caught that. The
// mocks here behave like the real thing: they stringify anything that is not
// a string / ArrayBuffer / view the way the platform does, so a transport
// that forwards an object untouched fails these tests the way it fails on a
// real wire.
//
// Run with: node --import ./test/_setup-globals.mjs --test test/wire-encoding.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  WebSocketTransport,
  WebRTCTransport,
  WebTransportTransport,
  encodeWireData,
  isWireNative,
} from '../src/index.mjs';

/** What a real wire does with its argument. */
function onTheWire(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data;
  return String(data); // the silent coercion: {} -> "[object Object]"
}

// ── encodeWireData ────────────────────────────────────────────────

describe('encodeWireData', () => {
  it('passes strings through untouched (no double-encoding)', () => {
    assert.equal(encodeWireData('{"a":1}'), '{"a":1}');
    assert.equal(encodeWireData(''), '');
  });

  it('passes binary through untouched', () => {
    const buf = new ArrayBuffer(4);
    const view = new Uint8Array([1, 2, 3]);
    assert.equal(encodeWireData(buf), buf);
    assert.equal(encodeWireData(view), view);
    assert.ok(isWireNative(buf) && isWireNative(view));
  });

  it('JSON-encodes objects, arrays and primitives', () => {
    assert.equal(encodeWireData({ type: 'x', n: 1 }), '{"type":"x","n":1}');
    assert.equal(encodeWireData([1, 2]), '[1,2]');
    assert.equal(encodeWireData(42), '42');
    assert.equal(encodeWireData(null), 'null');
    assert.equal(isWireNative({}), false);
  });

  it('refuses values with no JSON form instead of sending the text "undefined"', () => {
    assert.throws(() => encodeWireData(undefined), TypeError);
    assert.throws(() => encodeWireData(() => {}), TypeError);
  });
});

// ── WebSocketTransport ────────────────────────────────────────────

describe('WebSocketTransport.send() over a string/binary-only socket', () => {
  class StrictWebSocket {
    constructor() {
      this.readyState = 0;
      this._listeners = {};
      this.wire = [];
    }
    addEventListener(e, cb) { (this._listeners[e] ||= []).push(cb); }
    removeEventListener() {}
    send(data) { this.wire.push(onTheWire(data)); }
    close() {
      this.readyState = 3;
      setTimeout(() => (this._listeners.close || []).forEach((cb) => cb({ code: 1000, reason: '' })), 0);
    }
    _open() { this.readyState = 1; (this._listeners.open || []).forEach((cb) => cb({})); }
  }

  async function connected() {
    let sock;
    const t = new WebSocketTransport({
      url: 'ws://x',
      reconnect: false,
      _WebSocket: class extends StrictWebSocket { constructor() { super(); sock = this; } },
    });
    const p = t.connect();
    sock._open();
    await p;
    return { t, sock };
  }

  it('sends an envelope object as its JSON text, not "[object Object]"', async () => {
    const { t, sock } = await connected();
    t.send({ type: 'zz', a: 1 });
    assert.deepEqual(sock.wire, ['{"type":"zz","a":1}']);
    await t.close();
  });

  it('still sends strings and binary verbatim', async () => {
    const { t, sock } = await connected();
    const bytes = new Uint8Array([9, 8, 7]);
    t.send('already-text');
    t.send(bytes);
    assert.deepEqual(sock.wire, ['already-text', bytes]);
    await t.close();
  });
});

// ── WebRTCTransport (the class PeerNode sessions hold) ────────────

describe('WebRTCTransport.send() over a string/binary-only data channel', () => {
  class StrictDataChannel {
    constructor(label) {
      this.label = label;
      this.readyState = 'connecting';
      this._listeners = {};
      this.wire = [];
    }
    addEventListener(e, cb) { (this._listeners[e] ||= []).push(cb); }
    removeEventListener() {}
    send(data) { this.wire.push(onTheWire(data)); }
    close() { this.readyState = 'closed'; }
    _open() { this.readyState = 'open'; (this._listeners.open || []).forEach((cb) => cb({})); }
  }
  class StrictPC {
    constructor() { this.channels = []; this._listeners = {}; }
    addEventListener(e, cb) { (this._listeners[e] ||= []).push(cb); }
    createDataChannel(label) { const dc = new StrictDataChannel(label); this.channels.push(dc); return dc; }
    async createOffer() { return { type: 'offer', sdp: 'o' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async addIceCandidate() {}
    close() {}
  }
  function signaler() {
    let onAnswer;
    return {
      async sendOffer() {}, async sendAnswer() {}, async sendIceCandidate() {},
      onOffer() {}, onIceCandidate() {},
      onAnswer(cb) { onAnswer = cb; },
      answer() { onAnswer({ answer: { type: 'answer', sdp: 'a' } }); },
    };
  }
  async function connected() {
    let pc;
    const sig = signaler();
    const t = new WebRTCTransport({
      localPodId: 'a', remotePodId: 'b', signaler: sig,
      _RTCPeerConnection: class extends StrictPC { constructor() { super(); pc = this; } },
    });
    const p = t.connect();
    await new Promise((r) => setTimeout(r, 5));
    sig.answer();
    pc.channels.forEach((c) => c._open());
    await p;
    return { t, pc };
  }

  it('sends an envelope object as JSON text on the control channel', async () => {
    const { t, pc } = await connected();
    t.send({ type: 'zz', a: 1 });
    const [control] = pc.channels;
    assert.deepEqual(control.wire, ['{"type":"zz","a":1}']);
    await t.close();
  });

  it("sends an object on the bulk channel as JSON text too", async () => {
    const { t, pc } = await connected();
    t.send({ type: 'chunk', n: 2 }, { channel: 'bulk' });
    const bulk = pc.channels.find((c) => c.label === 'mesh-bulk');
    assert.deepEqual(bulk.wire, ['{"type":"chunk","n":2}']);
    assert.deepEqual(pc.channels.find((c) => c.label !== 'mesh-bulk').wire, []);
    await t.close();
  });

  it('still sends strings and binary verbatim', async () => {
    const { t, pc } = await connected();
    const bytes = new Uint8Array([1, 2]);
    t.send('text');
    t.send(bytes);
    assert.deepEqual(pc.channels[0].wire, ['text', bytes]);
    await t.close();
  });
});

// ── WebTransportTransport ─────────────────────────────────────────

describe('WebTransportTransport.send()', () => {
  it('encodes an envelope object as UTF-8 JSON bytes', async () => {
    const written = [];
    class FakeWT {
      constructor() {
        this.ready = Promise.resolve();
        this.closed = new Promise(() => {});
        this.datagrams = {
          writable: { getWriter: () => ({ write: async (b) => { written.push(b); }, close: async () => {} }) },
          readable: { getReader: () => ({ read: () => new Promise(() => {}), cancel() {} }) },
        };
      }
      close() {}
    }
    const t = new WebTransportTransport({ url: 'https://x', _WebTransport: FakeWT });
    await t.connect();
    await t.send({ type: 'zz', a: 1 });
    assert.ok(written[0] instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(written[0]), '{"type":"zz","a":1}');
    await t.close();
  });
});
