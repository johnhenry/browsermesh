// Run with: node --import ./test/_setup-globals.mjs --test test/streams.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  STREAM_STATES,
  STREAM_ERROR_CODES,
  STREAM_DEFAULTS,
  MeshStream,
  StreamMultiplexer,
} from '../src/streams.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('STREAM_STATES', () => {
  it('contains all 5 states', () => {
    assert.deepEqual(STREAM_STATES, ['IDLE', 'OPEN', 'HALF_CLOSED_LOCAL', 'HALF_CLOSED_REMOTE', 'CLOSED']);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(STREAM_STATES));
  });
});

describe('STREAM_ERROR_CODES', () => {
  it('contains expected error codes', () => {
    assert.deepEqual(STREAM_ERROR_CODES, ['CANCELLED', 'TIMEOUT', 'FLOW_CONTROL', 'TOO_LARGE', 'INTERNAL']);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(STREAM_ERROR_CODES));
  });
});

describe('STREAM_DEFAULTS', () => {
  it('has expected default values', () => {
    assert.equal(STREAM_DEFAULTS.initialCredits, 8);
    assert.equal(STREAM_DEFAULTS.maxCredits, 64);
    assert.equal(STREAM_DEFAULTS.idleTimeout, 30_000);
    assert.equal(STREAM_DEFAULTS.maxStreamSize, 256 * 1024 * 1024);
    assert.equal(STREAM_DEFAULTS.maxConcurrentStreams, 16);
    assert.equal(STREAM_DEFAULTS.maxChunkSize, 16_384);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(STREAM_DEFAULTS));
  });
});

// ---------------------------------------------------------------------------
// MeshStream — construction
// ---------------------------------------------------------------------------

describe('MeshStream', () => {
  let stream;

  beforeEach(() => {
    stream = new MeshStream({ method: 'test/upload', ordered: true });
  });

  it('starts in IDLE state', () => {
    assert.equal(stream.state, 'IDLE');
  });

  it('generates a 16-byte ID', () => {
    assert.equal(stream.id.length, 16);
    assert.equal(stream.hexId.length, 32);
  });

  it('stores method and options', () => {
    assert.equal(stream.method, 'test/upload');
    assert.equal(stream.ordered, true);
    assert.equal(stream.encrypted, false);
    assert.equal(stream.initiator, false);
  });

  it('defaults to 8 send/recv credits', () => {
    assert.equal(stream.sendCredits, 8);
    assert.equal(stream.recvCredits, 8);
  });

  it('accepts custom initial credits', () => {
    const s = new MeshStream({ initialCredits: 16 });
    assert.equal(s.sendCredits, 16);
    assert.equal(s.recvCredits, 16);
  });

  it('accepts metadata', () => {
    const s = new MeshStream({ metadata: { encoding: 'cbor' } });
    assert.deepEqual(s.metadata, { encoding: 'cbor' });
  });

  it('accepts encrypted flag', () => {
    const s = new MeshStream({ encrypted: true });
    assert.equal(s.encrypted, true);
  });

  it('records initiator flag', () => {
    const s = new MeshStream({ initiator: true });
    assert.equal(s.initiator, true);
  });
});

// ---------------------------------------------------------------------------
// MeshStream — state transitions
// ---------------------------------------------------------------------------

describe('MeshStream state transitions', () => {
  let stream;

  beforeEach(() => {
    stream = new MeshStream();
    stream._open();
  });

  it('transitions IDLE → OPEN', () => {
    const s = new MeshStream();
    assert.equal(s.state, 'IDLE');
    s._open();
    assert.equal(s.state, 'OPEN');
  });

  it('transitions OPEN → HALF_CLOSED_LOCAL via end()', () => {
    stream.end();
    assert.equal(stream.state, 'HALF_CLOSED_LOCAL');
  });

  it('transitions OPEN → HALF_CLOSED_REMOTE via _receiveEnd()', () => {
    stream._receiveEnd();
    assert.equal(stream.state, 'HALF_CLOSED_REMOTE');
  });

  it('transitions HALF_CLOSED_LOCAL → CLOSED via _receiveEnd()', () => {
    stream.end();
    stream._receiveEnd();
    assert.equal(stream.state, 'CLOSED');
  });

  it('transitions HALF_CLOSED_REMOTE → CLOSED via end()', () => {
    stream._receiveEnd();
    stream.end();
    assert.equal(stream.state, 'CLOSED');
  });

  it('transitions OPEN → CLOSED via cancel()', () => {
    stream.cancel('test');
    assert.equal(stream.state, 'CLOSED');
  });

  it('transitions OPEN → CLOSED via _receiveError()', () => {
    stream._receiveError('CANCELLED', 'test');
    assert.equal(stream.state, 'CLOSED');
  });

  it('rejects invalid transition IDLE → HALF_CLOSED_LOCAL', () => {
    const s = new MeshStream();
    assert.throws(() => s._transition('HALF_CLOSED_LOCAL'), /Invalid stream state transition/);
  });

  it('end() is idempotent on CLOSED', () => {
    stream.cancel();
    stream.end(); // should not throw
    assert.equal(stream.state, 'CLOSED');
  });

  it('cancel() is idempotent on CLOSED', () => {
    stream.cancel();
    stream.cancel(); // should not throw
    assert.equal(stream.state, 'CLOSED');
  });
});

// ---------------------------------------------------------------------------
// MeshStream — writing
// ---------------------------------------------------------------------------

describe('MeshStream writing', () => {
  it('writes data when credits are available', () => {
    const stream = new MeshStream({ initialCredits: 2 });
    stream._open();
    const result = stream.write(new Uint8Array([1, 2, 3]));
    assert.equal(result, true);
    assert.equal(stream.sendCredits, 1);
    assert.equal(stream.sendSeq, 1);
  });

  it('queues writes when credits exhausted', () => {
    const stream = new MeshStream({ initialCredits: 1 });
    stream._open();
    stream.write(new Uint8Array([1])); // uses last credit
    const result = stream.write(new Uint8Array([2]));
    assert.equal(result, false);
    assert.equal(stream.sendCredits, 0);
    assert.equal(stream.sendSeq, 1); // only first write counted
  });

  it('accepts string data (encodes to UTF-8)', () => {
    const stream = new MeshStream();
    stream._open();
    const result = stream.write('hello');
    assert.equal(result, true);
  });

  it('throws when writing in CLOSED state', () => {
    const stream = new MeshStream();
    stream._open();
    stream.cancel();
    assert.throws(() => stream.write(new Uint8Array([1])), /Cannot write in state CLOSED/);
  });

  it('throws when writing in IDLE state', () => {
    const stream = new MeshStream();
    assert.throws(() => stream.write(new Uint8Array([1])), /Cannot write in state IDLE/);
  });

  it('throws when writing in HALF_CLOSED_LOCAL state', () => {
    const stream = new MeshStream();
    stream._open();
    stream.end();
    assert.throws(() => stream.write(new Uint8Array([1])), /Cannot write in state HALF_CLOSED_LOCAL/);
  });

  it('allows writing in HALF_CLOSED_REMOTE state', () => {
    const stream = new MeshStream();
    stream._open();
    stream._receiveEnd();
    assert.equal(stream.state, 'HALF_CLOSED_REMOTE');
    const result = stream.write(new Uint8Array([1]));
    assert.equal(result, true);
  });

  it('throws on size limit exceeded', () => {
    const stream = new MeshStream({ maxSize: 5 });
    stream._open();
    assert.throws(() => stream.write(new Uint8Array(6)), /Stream size limit exceeded/);
  });

  it('sends data via multiplexer', () => {
    const sent = [];
    const mux = { _sendData(id, data, seq) { sent.push({ id, data, seq }); } };
    const stream = new MeshStream({ multiplexer: mux });
    stream._open();
    stream.write(new Uint8Array([42]));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].seq, 1);
  });
});

// ---------------------------------------------------------------------------
// MeshStream — flow control
// ---------------------------------------------------------------------------

describe('MeshStream flow control', () => {
  it('grants credits within limit', () => {
    const stream = new MeshStream({ initialCredits: 8 });
    stream._open();
    stream.grantCredits(4);
    assert.equal(stream.recvCredits, 12);
  });

  it('throws on zero or negative credits', () => {
    const stream = new MeshStream();
    stream._open();
    assert.throws(() => stream.grantCredits(0), /Credits must be positive/);
    assert.throws(() => stream.grantCredits(-1), /Credits must be positive/);
  });

  it('throws when credits would exceed max', () => {
    const stream = new MeshStream({ initialCredits: 60 });
    stream._open();
    assert.throws(() => stream.grantCredits(10), /Credits would exceed max/);
  });

  it('receives credits and drains queue', () => {
    const stream = new MeshStream({ initialCredits: 1 });
    stream._open();
    stream.write(new Uint8Array([1])); // uses credit
    stream.write(new Uint8Array([2])); // queued
    assert.equal(stream.sendSeq, 1);
    stream._receiveCredits(2);
    assert.equal(stream.sendSeq, 2); // queued item sent
  });

  it('caps received credits at maxCredits', () => {
    const stream = new MeshStream({ initialCredits: 60 });
    stream._open();
    stream._receiveCredits(100);
    assert.equal(stream.sendCredits, 64); // capped at maxCredits
  });

  it('fires onCredits callback', () => {
    let received = null;
    const stream = new MeshStream({ initialCredits: 1 });
    stream._open();
    stream.onCredits(n => { received = n; });
    stream._receiveCredits(3);
    assert.equal(received, 4);
  });
});

// ---------------------------------------------------------------------------
// MeshStream — receive path
// ---------------------------------------------------------------------------

describe('MeshStream receive path', () => {
  it('fires onData callback with data and seq', () => {
    let received = null;
    const stream = new MeshStream();
    stream._open();
    stream.onData((data, seq) => { received = { data, seq }; });
    stream._receiveData(new Uint8Array([10, 20]), 1);
    assert.deepEqual(received.data, new Uint8Array([10, 20]));
    assert.equal(received.seq, 1);
    assert.equal(stream.recvSeq, 1);
  });

  it('fires onEnd callback', () => {
    let ended = false;
    const stream = new MeshStream();
    stream._open();
    stream.onEnd(() => { ended = true; });
    stream._receiveEnd();
    assert.ok(ended);
  });

  it('fires onError callback', () => {
    let error = null;
    const stream = new MeshStream();
    stream._open();
    stream.onError(e => { error = e; });
    stream._receiveError('TIMEOUT', 'Idle timeout');
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.message, 'Idle timeout');
  });

  it('tracks bytesReceived and framesReceived', () => {
    const stream = new MeshStream();
    stream._open();
    stream._receiveData(new Uint8Array(100), 1);
    stream._receiveData(new Uint8Array(50), 2);
    const stats = stream.getStats();
    assert.equal(stats.bytesReceived, 150);
    assert.equal(stats.framesReceived, 2);
  });

  it('ignores data in CLOSED state', () => {
    let called = false;
    const stream = new MeshStream();
    stream._open();
    stream.cancel();
    stream.onData(() => { called = true; });
    stream._receiveData(new Uint8Array([1]), 1);
    assert.ok(!called);
  });
});

// ---------------------------------------------------------------------------
// MeshStream — stats
// ---------------------------------------------------------------------------

describe('MeshStream getStats', () => {
  it('returns zero stats initially', () => {
    const stream = new MeshStream();
    const stats = stream.getStats();
    assert.equal(stats.bytesSent, 0);
    assert.equal(stats.bytesReceived, 0);
    assert.equal(stats.framesSent, 0);
    assert.equal(stats.framesReceived, 0);
    assert.ok(stats.duration >= 0);
  });

  it('tracks sent bytes and frames', () => {
    const stream = new MeshStream();
    stream._open();
    stream.write(new Uint8Array(10));
    stream.write(new Uint8Array(20));
    const stats = stream.getStats();
    assert.equal(stats.bytesSent, 30);
    assert.equal(stats.framesSent, 2);
  });
});

// ---------------------------------------------------------------------------
// MeshStream — serialization
// ---------------------------------------------------------------------------

describe('MeshStream toJSON/fromJSON', () => {
  it('round-trips via JSON', () => {
    const stream = new MeshStream({ method: 'test/rpc', ordered: false, encrypted: true, metadata: { x: 1 } });
    stream._open();
    stream.write(new Uint8Array(10));
    stream._receiveData(new Uint8Array(5), 1);

    const json = stream.toJSON();
    const restored = MeshStream.fromJSON(json);

    assert.equal(restored.hexId, stream.hexId);
    assert.equal(restored.state, 'OPEN');
    assert.equal(restored.method, 'test/rpc');
    assert.equal(restored.ordered, false);
    assert.equal(restored.encrypted, true);
    assert.deepEqual(restored.metadata, { x: 1 });
    const stats = restored.getStats();
    assert.equal(stats.bytesSent, 10);
    assert.equal(stats.bytesReceived, 5);
  });

  it('preserves CLOSED state', () => {
    const stream = new MeshStream();
    stream._open();
    stream.cancel();
    const json = stream.toJSON();
    const restored = MeshStream.fromJSON(json);
    assert.equal(restored.state, 'CLOSED');
    assert.ok(json.closedAt !== null);
  });
});

// ---------------------------------------------------------------------------
// StreamMultiplexer — construction
// ---------------------------------------------------------------------------

describe('StreamMultiplexer', () => {
  let mux;

  beforeEach(() => {
    mux = new StreamMultiplexer();
  });

  it('starts with zero streams', () => {
    assert.equal(mux.activeCount, 0);
    assert.equal(mux.size, 0);
  });

  it('accepts custom maxConcurrentStreams', () => {
    const m = new StreamMultiplexer({ maxConcurrentStreams: 4 });
    // Open 4 streams
    for (let i = 0; i < 4; i++) m.open(`test/${i}`);
    assert.equal(m.activeCount, 4);
    assert.throws(() => m.open('test/5'), /Concurrent stream limit reached/);
  });
});

// ---------------------------------------------------------------------------
// StreamMultiplexer — open
// ---------------------------------------------------------------------------

describe('StreamMultiplexer open', () => {
  it('creates and returns an OPEN stream', () => {
    const mux = new StreamMultiplexer();
    const stream = mux.open('upload');
    assert.equal(stream.state, 'OPEN');
    assert.equal(stream.method, 'upload');
    assert.equal(stream.initiator, true);
    assert.equal(mux.activeCount, 1);
  });

  it('emits STREAM_OPEN message', () => {
    const sent = [];
    const mux = new StreamMultiplexer();
    mux.onSend(msg => sent.push(msg));
    const stream = mux.open('test', { ordered: false, encrypted: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].t, 0xaf); // STREAM_OPEN
    assert.equal(sent[0].p.method, 'test');
    assert.equal(sent[0].p.ordered, false);
    assert.equal(sent[0].p.encrypted, true);
  });

  it('throws when max concurrent reached', () => {
    const mux = new StreamMultiplexer({ maxConcurrentStreams: 2 });
    mux.open('a');
    mux.open('b');
    assert.throws(() => mux.open('c'), /Concurrent stream limit/);
  });

  it('uses custom initial credits', () => {
    const mux = new StreamMultiplexer();
    const stream = mux.open('test', { initialCredits: 32 });
    assert.equal(stream.sendCredits, 32);
  });
});

// ---------------------------------------------------------------------------
// StreamMultiplexer — dispatch
// ---------------------------------------------------------------------------

describe('StreamMultiplexer dispatch', () => {
  it('creates stream on inbound STREAM_OPEN', () => {
    const mux = new StreamMultiplexer();
    let incoming = null;
    mux.onStream(s => { incoming = s; });

    mux.dispatch({
      t: 0xaf,
      p: {
        streamId: 'aa'.repeat(16),
        method: 'download',
        ordered: true,
        initialCredits: 8,
      },
    });

    assert.ok(incoming);
    assert.equal(incoming.method, 'download');
    assert.equal(incoming.state, 'OPEN');
    assert.equal(incoming.initiator, false);
    assert.equal(mux.activeCount, 1);
  });

  it('routes STREAM_DATA to existing stream', () => {
    const mux = new StreamMultiplexer();
    let received = null;
    mux.onStream(s => { s.onData((d, seq) => { received = { d, seq }; }); });

    const streamId = 'bb'.repeat(16);
    mux.dispatch({ t: 0xaf, p: { streamId, method: 'test', initialCredits: 8 } });
    mux.dispatch({ t: 0x13, p: { streamId, data: new Uint8Array([1, 2]), seq: 1 } });

    assert.ok(received);
    assert.deepEqual(received.d, new Uint8Array([1, 2]));
    assert.equal(received.seq, 1);
  });

  it('routes STREAM_END to existing stream', () => {
    const mux = new StreamMultiplexer();
    let ended = false;
    mux.onStream(s => { s.onEnd(() => { ended = true; }); });

    const streamId = 'cc'.repeat(16);
    mux.dispatch({ t: 0xaf, p: { streamId, method: 'test', initialCredits: 8 } });
    mux.dispatch({ t: 0x14, p: { streamId } });

    assert.ok(ended);
  });

  it('routes STREAM_ERROR to existing stream', () => {
    const mux = new StreamMultiplexer();
    let error = null;
    mux.onStream(s => { s.onError(e => { error = e; }); });

    const streamId = 'dd'.repeat(16);
    mux.dispatch({ t: 0xaf, p: { streamId, method: 'test', initialCredits: 8 } });
    mux.dispatch({ t: 0x15, p: { streamId, code: 'TIMEOUT', message: 'timed out' } });

    assert.ok(error);
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(mux.activeCount, 0); // Removed on error
  });

  it('routes STREAM_WINDOW_UPDATE to existing stream', () => {
    const mux = new StreamMultiplexer();
    const stream = mux.open('test', { initialCredits: 2 });
    stream.write(new Uint8Array([1])); // credit 2→1
    stream.write(new Uint8Array([2])); // credit 1→0

    mux.dispatch({ t: 0x16, p: { streamId: stream.hexId, additionalCredits: 4 } });
    assert.equal(stream.sendCredits, 4);
  });

  it('sends error for unknown stream ID', () => {
    const sent = [];
    const mux = new StreamMultiplexer();
    mux.onSend(msg => sent.push(msg));

    mux.dispatch({ t: 0x13, p: { streamId: 'ee'.repeat(16), data: new Uint8Array([1]), seq: 1 } });

    const errorMsg = sent.find(m => m.t === 0x15);
    assert.ok(errorMsg);
    assert.equal(errorMsg.p.code, 'INTERNAL');
  });

  it('ignores null/undefined messages', () => {
    const mux = new StreamMultiplexer();
    mux.dispatch(null);
    mux.dispatch(undefined);
    mux.dispatch({});
    mux.dispatch({ p: {} }); // no streamId
    assert.equal(mux.activeCount, 0);
  });

  it('rejects inbound stream when at capacity', () => {
    const sent = [];
    const mux = new StreamMultiplexer({ maxConcurrentStreams: 1 });
    mux.onSend(msg => sent.push(msg));
    mux.open('a');

    mux.dispatch({ t: 0xaf, p: { streamId: 'ff'.repeat(16), method: 'b', initialCredits: 8 } });

    assert.equal(mux.activeCount, 1);
    const errorMsg = sent.find(m => m.t === 0x15);
    assert.ok(errorMsg);
    assert.equal(errorMsg.p.code, 'FLOW_CONTROL');
  });
});

// ---------------------------------------------------------------------------
// StreamMultiplexer — close / closeAll
// ---------------------------------------------------------------------------

describe('StreamMultiplexer close/closeAll', () => {
  it('closes a specific stream by ID', () => {
    const mux = new StreamMultiplexer();
    const stream = mux.open('test');
    // Half-close local, then simulate remote end to fully close
    mux.close(stream.hexId);
    assert.equal(stream.state, 'HALF_CLOSED_LOCAL');
    // Now remote end arrives
    mux.dispatch({ t: 0x14, p: { streamId: stream.hexId } });
    assert.equal(stream.state, 'CLOSED');
  });

  it('closeAll cancels all streams', () => {
    const mux = new StreamMultiplexer();
    mux.open('a');
    mux.open('b');
    mux.open('c');
    assert.equal(mux.activeCount, 3);
    mux.closeAll();
    assert.equal(mux.activeCount, 0);
    assert.equal(mux.size, 0);
  });

  it('close is no-op for unknown ID', () => {
    const mux = new StreamMultiplexer();
    mux.close('nonexistent');
    assert.equal(mux.activeCount, 0);
  });
});

// ---------------------------------------------------------------------------
// StreamMultiplexer — queries
// ---------------------------------------------------------------------------

describe('StreamMultiplexer queries', () => {
  it('getStream returns stream by hex ID', () => {
    const mux = new StreamMultiplexer();
    const stream = mux.open('test');
    assert.equal(mux.getStream(stream.hexId), stream);
  });

  it('getStream returns undefined for unknown ID', () => {
    const mux = new StreamMultiplexer();
    assert.equal(mux.getStream('nope'), undefined);
  });

  it('listStreams returns all streams', () => {
    const mux = new StreamMultiplexer();
    mux.open('a');
    mux.open('b');
    assert.equal(mux.listStreams().length, 2);
  });

  it('listStreams filters by state', () => {
    const mux = new StreamMultiplexer();
    const s1 = mux.open('a');
    mux.open('b');
    s1.end();
    assert.equal(mux.listStreams('HALF_CLOSED_LOCAL').length, 1);
    assert.equal(mux.listStreams('OPEN').length, 1);
  });
});

// ---------------------------------------------------------------------------
// StreamMultiplexer — bidirectional pair test
// ---------------------------------------------------------------------------

describe('StreamMultiplexer bidirectional pair', () => {
  it('two multiplexers exchange data', () => {
    const muxA = new StreamMultiplexer();
    const muxB = new StreamMultiplexer();

    // Wire them together
    muxA.onSend(msg => muxB.dispatch(msg));
    muxB.onSend(msg => muxA.dispatch(msg));

    const receivedByB = [];
    muxB.onStream(stream => {
      stream.onData(data => receivedByB.push(data));
    });

    const streamA = muxA.open('chat');
    streamA.write(new Uint8Array([1, 2, 3]));
    streamA.write(new Uint8Array([4, 5, 6]));

    assert.equal(receivedByB.length, 2);
    assert.deepEqual(receivedByB[0], new Uint8Array([1, 2, 3]));
    assert.deepEqual(receivedByB[1], new Uint8Array([4, 5, 6]));
  });

  it('bidirectional data flow works', () => {
    const muxA = new StreamMultiplexer();
    const muxB = new StreamMultiplexer();
    muxA.onSend(msg => muxB.dispatch(msg));
    muxB.onSend(msg => muxA.dispatch(msg));

    const receivedByA = [];
    const receivedByB = [];

    muxB.onStream(stream => {
      stream.onData(data => receivedByB.push(data));
    });

    const streamA = muxA.open('echo');
    streamA.onData(data => receivedByA.push(data));
    streamA.write(new Uint8Array([1]));

    // B writes back after A has registered its onData
    const streamB = muxB.listStreams()[0];
    streamB.write(new Uint8Array([99]));

    assert.equal(receivedByB.length, 1);
    assert.equal(receivedByA.length, 1);
    assert.deepEqual(receivedByA[0], new Uint8Array([99]));
  });

  it('clean close propagates between peers', () => {
    const muxA = new StreamMultiplexer();
    const muxB = new StreamMultiplexer();
    muxA.onSend(msg => muxB.dispatch(msg));
    muxB.onSend(msg => muxA.dispatch(msg));

    let bEnded = false;
    muxB.onStream(stream => {
      stream.onEnd(() => { bEnded = true; });
    });

    const streamA = muxA.open('test');
    streamA.end();
    assert.ok(bEnded);
  });
});

// ---------------------------------------------------------------------------
// StreamMultiplexer — serialization
// ---------------------------------------------------------------------------

describe('StreamMultiplexer toJSON/fromJSON', () => {
  it('round-trips via JSON', () => {
    const mux = new StreamMultiplexer({ maxConcurrentStreams: 8 });
    mux.open('a');
    mux.open('b');

    const json = mux.toJSON();
    const restored = StreamMultiplexer.fromJSON(json);

    assert.equal(restored.size, 2);
    assert.equal(Object.keys(json.streams).length, 2);
    assert.equal(json.maxConcurrent, 8);
  });

  it('preserves stream states', () => {
    const mux = new StreamMultiplexer();
    const s = mux.open('test');
    s.write(new Uint8Array(10));
    s.end();

    const json = mux.toJSON();
    const restored = StreamMultiplexer.fromJSON(json);
    const streams = restored.listStreams();
    assert.equal(streams.length, 1);
    assert.equal(streams[0].state, 'HALF_CLOSED_LOCAL');
  });
});
