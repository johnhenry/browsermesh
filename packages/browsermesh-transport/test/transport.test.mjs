// Run with: node --import ./test/_setup-globals.mjs --test test/transport.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MeshTransport,
  MockMeshTransport,
  MeshTransportNegotiator,
  TRANSPORT_TYPES,
  TRANSPORT_STATES,
} from '../src/transport.mjs';

// ── TRANSPORT_TYPES ─────────────────────────────────────────────

describe('TRANSPORT_TYPES', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(TRANSPORT_TYPES));
  });

  it('contains the three expected transport types', () => {
    assert.deepEqual(TRANSPORT_TYPES, ['webrtc', 'wsh-wt', 'wsh-ws']);
  });

  it('cannot be modified', () => {
    assert.throws(() => { TRANSPORT_TYPES.push('extra'); }, TypeError);
  });
});

// ── TRANSPORT_STATES ────────────────────────────────────────────

describe('TRANSPORT_STATES', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(TRANSPORT_STATES));
  });

  it('contains five expected states in order', () => {
    assert.deepEqual(TRANSPORT_STATES, [
      'disconnected',
      'connecting',
      'connected',
      'closing',
      'closed',
    ]);
  });

  it('cannot be modified', () => {
    assert.throws(() => { TRANSPORT_STATES.push('extra'); }, TypeError);
  });
});

// ── MeshTransport (abstract base) ───────────────────────────────

describe('MeshTransport', () => {
  it('rejects unknown transport type', () => {
    assert.throws(
      () => new MeshTransport('carrier-pigeon'),
      /Unknown transport type/,
    );
  });

  it('accepts all valid transport types', () => {
    for (const type of TRANSPORT_TYPES) {
      const t = new MeshTransport(type);
      assert.equal(t.type, type);
    }
  });

  it('starts in disconnected state', () => {
    const t = new MeshTransport('webrtc');
    assert.equal(t.state, 'disconnected');
    assert.equal(t.connected, false);
  });

  it('latency defaults to 0', () => {
    const t = new MeshTransport('webrtc');
    assert.equal(t.latency, 0);
  });

  it('connect() throws by default (abstract)', async () => {
    const t = new MeshTransport('wsh-ws');
    await assert.rejects(
      () => t.connect('wss://example.com'),
      /connect\(\) must be implemented by subclass/,
    );
  });

  it('send() throws by default (abstract)', () => {
    const t = new MeshTransport('wsh-wt');
    assert.throws(
      () => t.send('hello'),
      /send\(\) must be implemented by subclass/,
    );
  });

  it('close() transitions to closed state', () => {
    const t = new MeshTransport('webrtc');
    t.close();
    assert.equal(t.state, 'closed');
  });

  it('close() fires the close callback', () => {
    const t = new MeshTransport('webrtc');
    let fired = false;
    t.onClose(() => { fired = true; });
    t.close();
    assert.equal(fired, true);
  });

  it('toJSON returns type, state, and latency', () => {
    const t = new MeshTransport('wsh-ws');
    const json = t.toJSON();
    assert.deepEqual(json, {
      type: 'wsh-ws',
      state: 'disconnected',
      latency: 0,
    });
  });

  it('toJSON reflects current state after close', () => {
    const t = new MeshTransport('webrtc');
    t.close();
    assert.equal(t.toJSON().state, 'closed');
  });

  it('onStream registers callback without error', () => {
    const t = new MeshTransport('webrtc');
    t.onStream(() => {});
  });

  it('onError registers callback without error', () => {
    const t = new MeshTransport('webrtc');
    t.onError(() => {});
  });

  it('onMessage registers callback without error', () => {
    const t = new MeshTransport('webrtc');
    t.onMessage(() => {});
  });
});

// ── MockMeshTransport ───────────────────────────────────────────

describe('MockMeshTransport', () => {
  it('defaults to wsh-ws transport type', () => {
    const mock = new MockMeshTransport();
    assert.equal(mock.type, 'wsh-ws');
  });

  it('accepts a custom transport type', () => {
    const mock = new MockMeshTransport('webrtc');
    assert.equal(mock.type, 'webrtc');
  });

  it('connect sets state to connected', async () => {
    const mock = new MockMeshTransport();
    await mock.connect('wss://endpoint');
    assert.equal(mock.state, 'connected');
    assert.equal(mock.connected, true);
  });

  it('connect sets latency to 1', async () => {
    const mock = new MockMeshTransport();
    await mock.connect('wss://endpoint');
    assert.equal(mock.latency, 1);
  });

  it('send throws when not connected', () => {
    const mock = new MockMeshTransport();
    assert.throws(
      () => mock.send('hello'),
      /Transport not connected/,
    );
  });

  it('send records messages when connected', async () => {
    const mock = new MockMeshTransport();
    await mock.connect('wss://endpoint');
    mock.send('msg1');
    mock.send({ type: 'data', payload: 42 });
    assert.equal(mock.sentMessages.length, 2);
    assert.equal(mock.sentMessages[0], 'msg1');
    assert.deepEqual(mock.sentMessages[1], { type: 'data', payload: 42 });
  });

  it('sentMessages returns a copy', async () => {
    const mock = new MockMeshTransport();
    await mock.connect('wss://endpoint');
    mock.send('msg');
    const msgs = mock.sentMessages;
    msgs.push('extra');
    assert.deepEqual(mock.sentMessages, ['msg']);
  });

  it('pair delivers messages bidirectionally', async () => {
    const a = new MockMeshTransport();
    const b = new MockMeshTransport();
    await a.connect('ep-a');
    await b.connect('ep-b');
    a.pair(b);

    const receivedByA = [];
    const receivedByB = [];
    a.onMessage(data => receivedByA.push(data));
    b.onMessage(data => receivedByB.push(data));

    a.send('from-a');
    b.send('from-b');

    assert.deepEqual(receivedByB, ['from-a']);
    assert.deepEqual(receivedByA, ['from-b']);
  });

  it('pair records sent messages only on the sender side', async () => {
    const a = new MockMeshTransport();
    const b = new MockMeshTransport();
    await a.connect('ep-a');
    await b.connect('ep-b');
    a.pair(b);

    a.send('hello');
    assert.deepEqual(a.sentMessages, ['hello']);
    assert.deepEqual(b.sentMessages, []);
  });

  it('close transitions to closed state', async () => {
    const mock = new MockMeshTransport();
    await mock.connect('ep');
    mock.close();
    assert.equal(mock.state, 'closed');
    assert.equal(mock.connected, false);
  });

  it('close detaches own partner so sends no longer deliver', async () => {
    const a = new MockMeshTransport();
    const b = new MockMeshTransport();
    await a.connect('ep-a');
    await b.connect('ep-b');
    a.pair(b);

    // Verify a can send to b before close
    const receivedByB = [];
    b.onMessage(data => receivedByB.push(data));
    a.send('before-close');
    assert.deepEqual(receivedByB, ['before-close']);

    a.close();
    assert.equal(a.state, 'closed');
    assert.equal(a.connected, false);

    // After a.close(), a's partner ref is null, so a cannot deliver to b
    // (a is closed and cannot send anyway -- send throws when not connected)
    assert.throws(() => a.send('should-fail'), /not connected/);
  });

  it('close fires close callback', async () => {
    const mock = new MockMeshTransport();
    await mock.connect('ep');
    let closed = false;
    mock.onClose(() => { closed = true; });
    mock.close();
    assert.equal(closed, true);
  });

  it('callback errors do not propagate on message delivery', async () => {
    const a = new MockMeshTransport();
    const b = new MockMeshTransport();
    await a.connect('ep-a');
    await b.connect('ep-b');
    a.pair(b);

    b.onMessage(() => { throw new Error('listener fail'); });
    // should not throw
    a.send('test');
    assert.deepEqual(a.sentMessages, ['test']);
  });
});

// ── MeshTransportNegotiator ─────────────────────────────────────

describe('MeshTransportNegotiator', () => {
  /** @type {MeshTransportNegotiator} */
  let neg;

  beforeEach(() => {
    neg = new MeshTransportNegotiator();
  });

  it('registerAdapter stores an adapter', () => {
    neg.registerAdapter('wsh-ws', async () => new MockMeshTransport());
    assert.deepEqual(neg.availableTypes(), ['wsh-ws']);
  });

  it('registerAdapter rejects unknown transport type', () => {
    assert.throws(
      () => neg.registerAdapter('smoke-signal', async () => {}),
      /Unknown transport type/,
    );
  });

  it('negotiate selects highest-priority adapter', async () => {
    neg.registerAdapter('webrtc', async (ep) => {
      const t = new MockMeshTransport('webrtc');
      await t.connect(ep);
      return t;
    });
    neg.registerAdapter('wsh-ws', async (ep) => {
      const t = new MockMeshTransport('wsh-ws');
      await t.connect(ep);
      return t;
    });

    const endpoints = { webrtc: 'rtc://peer', 'wsh-ws': 'ws://peer' };
    const transport = await neg.negotiate(endpoints);
    assert.equal(transport.type, 'webrtc'); // preferred over wsh-ws
  });

  it('negotiate falls back when preferred adapter fails', async () => {
    neg.registerAdapter('webrtc', async () => {
      throw new Error('WebRTC unavailable');
    });
    neg.registerAdapter('wsh-ws', async (ep) => {
      const t = new MockMeshTransport('wsh-ws');
      await t.connect(ep);
      return t;
    });

    const endpoints = { webrtc: 'rtc://peer', 'wsh-ws': 'ws://peer' };
    const transport = await neg.negotiate(endpoints);
    assert.equal(transport.type, 'wsh-ws');
  });

  it('negotiate tries adapters in preference order', async () => {
    const order = [];
    neg.registerAdapter('webrtc', async () => {
      order.push('webrtc');
      throw new Error('fail');
    });
    neg.registerAdapter('wsh-wt', async () => {
      order.push('wsh-wt');
      throw new Error('fail');
    });
    neg.registerAdapter('wsh-ws', async (ep) => {
      order.push('wsh-ws');
      const t = new MockMeshTransport('wsh-ws');
      await t.connect(ep);
      return t;
    });

    await neg.negotiate({
      webrtc: 'rtc://peer',
      'wsh-wt': 'wt://peer',
      'wsh-ws': 'ws://peer',
    });
    assert.deepEqual(order, ['webrtc', 'wsh-wt', 'wsh-ws']);
  });

  it('negotiate throws when all adapters fail', async () => {
    neg.registerAdapter('webrtc', async () => { throw new Error('fail-rtc'); });
    neg.registerAdapter('wsh-ws', async () => { throw new Error('fail-ws'); });

    await assert.rejects(
      () => neg.negotiate({ webrtc: 'rtc://bad', 'wsh-ws': 'ws://bad' }),
      /All transports failed/,
    );
  });

  it('negotiate skips types with no registered adapter', async () => {
    // Only register wsh-ws, not webrtc
    neg.registerAdapter('wsh-ws', async (ep) => {
      const t = new MockMeshTransport('wsh-ws');
      await t.connect(ep);
      return t;
    });

    const endpoints = { webrtc: 'rtc://peer', 'wsh-ws': 'ws://peer' };
    const transport = await neg.negotiate(endpoints);
    assert.equal(transport.type, 'wsh-ws');
  });

  it('negotiate skips types with no endpoint', async () => {
    const tried = [];
    neg.registerAdapter('webrtc', async () => {
      tried.push('webrtc');
      throw new Error('fail');
    });
    neg.registerAdapter('wsh-ws', async (ep) => {
      tried.push('wsh-ws');
      const t = new MockMeshTransport('wsh-ws');
      await t.connect(ep);
      return t;
    });

    // Only provide wsh-ws endpoint
    const transport = await neg.negotiate({ 'wsh-ws': 'ws://peer' });
    assert.deepEqual(tried, ['wsh-ws']);
    assert.equal(transport.type, 'wsh-ws');
  });

  it('negotiate throws when endpoints object is empty', async () => {
    neg.registerAdapter('webrtc', async () => new MockMeshTransport('webrtc'));
    await assert.rejects(
      () => neg.negotiate({}),
      /All transports failed/,
    );
  });

  it('availableTypes returns empty array initially', () => {
    assert.deepEqual(neg.availableTypes(), []);
  });

  it('availableTypes lists all registered adapter types', () => {
    neg.registerAdapter('wsh-ws', async () => {});
    neg.registerAdapter('webrtc', async () => {});
    const types = neg.availableTypes();
    assert.ok(types.includes('wsh-ws'));
    assert.ok(types.includes('webrtc'));
    assert.equal(types.length, 2);
  });

  it('preferenceOrder defaults to webrtc, wsh-wt, wsh-ws', () => {
    assert.deepEqual(neg.preferenceOrder, ['webrtc', 'wsh-wt', 'wsh-ws']);
  });

  it('preferenceOrder can be overridden via constructor', () => {
    const custom = new MeshTransportNegotiator({
      preferenceOrder: ['wsh-ws', 'webrtc'],
    });
    assert.deepEqual(custom.preferenceOrder, ['wsh-ws', 'webrtc']);
  });

  it('preferenceOrder returns a copy', () => {
    const order = neg.preferenceOrder;
    order.push('carrier-pigeon');
    assert.equal(neg.preferenceOrder.length, 3);
  });

  it('custom preferenceOrder affects negotiation priority', async () => {
    const custom = new MeshTransportNegotiator({
      preferenceOrder: ['wsh-ws', 'webrtc'],
    });

    const order = [];
    custom.registerAdapter('webrtc', async (ep) => {
      order.push('webrtc');
      const t = new MockMeshTransport('webrtc');
      await t.connect(ep);
      return t;
    });
    custom.registerAdapter('wsh-ws', async (ep) => {
      order.push('wsh-ws');
      const t = new MockMeshTransport('wsh-ws');
      await t.connect(ep);
      return t;
    });

    const transport = await custom.negotiate({
      webrtc: 'rtc://peer',
      'wsh-ws': 'ws://peer',
    });
    // wsh-ws is preferred now
    assert.equal(order[0], 'wsh-ws');
    assert.equal(transport.type, 'wsh-ws');
  });
});
