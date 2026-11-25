/**
 * GatewayBackend against a REAL wsh host.
 *
 * gateway-backend.test.mjs drives the backend with a hand-written MockWshClient. That
 * proves the backend reads the messages the mock sends, not the ones wsh sends. This file
 * connects a real `WshClient` to a real host (no sockets of our own: the connection is an
 * in-memory socket pair, the login a real Ed25519 login) and checks the same behaviours
 * end to end. The mock tests stay: they reach corners a real host will not produce on request.
 *
 * Two real hosts are used:
 * - `createWshServer` from `@johnhenry/wsh/server`, with a TCP gateway to a local echo server:
 *   connect, data both ways, close, refusal by policy, connection refused, name not found,
 *   too many connections, listen; then bulk data (4 MiB each way, every byte checked) and slow readers on both
 *   sides, which is what wsh's `gateway-credit` flow control is for; and one UDP datagram (send-only).
 * - `createMemoryHost` from `@johnhenry/wsh/memory`, whose gateway answers named endpoints
 *   only: every TCP, DNS and listen request is refused.
 *
 * `@johnhenry/wsh` is a dev dependency of this package; without it the file skips.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { GatewayBackend } from '../src/gateway-backend.mjs';
import { GATEWAY_ERROR } from '../src/constants.mjs';

let wsh = null;
let memory = null;
let serverMod = null;
try {
  wsh = await import('@johnhenry/wsh');
  memory = await import('@johnhenry/wsh/memory');
  serverMod = await import('@johnhenry/wsh/server');
} catch { /* skipped below */ }

const skip = wsh ? false : '@johnhenry/wsh is not installed';

/** A raw 32-byte public key, for `authorizedKeys`. */
async function rawPublic(keyPair) {
  return new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
}

/** Start a TCP echo server on 127.0.0.1. `onConnection` sees every accepted socket. */
async function startEcho(onConnection) {
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    if (onConnection) onConnection(s);
    else s.on('data', (d) => s.write(d));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    sockets,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A real `createWshServer` served over an in-memory socket pair, and a connected real client. */
async function startServerHost(gateway) {
  const keyPair = await wsh.generateKeyPair();
  const server = serverMod.createWshServer({
    auth: { authorizedKeys: [await rawPublic(keyPair)] },
    gateway,
  });
  class DialWebSocket {
    constructor() {
      const [client, serverEnd] = memory.createSocketPair();
      void server.accept(serverEnd, { remote: { address: 'memory' } });
      return client;
    }
  }
  const client = new wsh.WshClient({
    transportFactories: {
      ws: () => new wsh.WebSocketTransport({ WebSocket: DialWebSocket }),
      wt: () => { throw new Error('no WebTransport in memory'); },
    },
  });
  await client.connect('ws://memory/', { transport: 'ws', username: 'tester', keyPair });
  const backend = new GatewayBackend({ wshClient: client, operationTimeoutMs: 10_000 });
  return {
    client,
    backend,
    async close() {
      await backend.close();
      try { await client.disconnect?.(); } catch { /* already down */ }
      await server.close();
    },
  };
}

/** The numeric code a refusal carries in its message: `... (code: 4)`. */
const codeOf = (err) => Number(/\(code: (\d+)\)/.exec(err.message)?.[1]);

/** Read until `n` bytes have arrived or the socket ends. */
async function readBytes(socket, n) {
  const parts = [];
  let have = 0;
  while (have < n) {
    const chunk = await socket.read();
    if (chunk === null) break;
    parts.push(chunk);
    have += chunk.length;
  }
  const out = new Uint8Array(have);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const text = (s) => new TextEncoder().encode(s);

describe('GatewayBackend against a real wsh server host', { skip }, () => {
  let echo;
  let host;
  before(async () => {
    echo = await startEcho();
    host = await startServerHost({
      allow: ['127.0.0.1', 'nonexistent.invalid'],
      allowPrivate: ['127.0.0.1'],
      maxConnections: 2,
    });
  });
  after(async () => {
    await host?.close();
    await echo?.close();
  });

  it('the client is authenticated, so the backend reports connected', () => {
    assert.equal(host.client.state, 'authenticated');
    assert.equal(host.backend.connected, true);
  });

  it('connect, then data flows both ways through the host', async () => {
    const socket = await host.backend.connect('127.0.0.1', echo.port);
    await socket.write(text('hello gateway'));
    const back = await readBytes(socket, 13);
    assert.equal(new TextDecoder().decode(back), 'hello gateway');
    // a second, larger write: the stream stays usable after the first exchange
    const big = new Uint8Array(40_000).fill(7);
    await socket.write(big);
    const bigBack = await readBytes(socket, big.length);
    assert.equal(bigBack.length, big.length);
    assert.ok(bigBack.every((b) => b === 7));
    await socket.close();
  });

  it('closing the local socket ends the remote connection', async () => {
    const seenEnd = Promise.withResolvers();
    const own = await startEcho((s) => {
      s.on('data', (d) => s.write(d));
      s.on('close', () => seenEnd.resolve(true));
    });
    try {
      const socket = await host.backend.connect('127.0.0.1', own.port);
      await socket.write(text('x'));
      await readBytes(socket, 1);
      await socket.close();
      assert.equal(await seenEnd.promise, true);
    } finally {
      await own.close();
    }
  });

  it('the remote closing ends the local socket with end of stream', async () => {
    const own = await startEcho((s) => { s.end(text('bye')); });
    try {
      const socket = await host.backend.connect('127.0.0.1', own.port);
      const got = await readBytes(socket, 3);
      assert.equal(new TextDecoder().decode(got), 'bye');
      assert.equal(await socket.read(), null);
    } finally {
      await own.close();
    }
  });

  it('a destination outside the allow list is refused with POLICY_DENIED', async () => {
    await assert.rejects(
      () => host.backend.connect('192.0.2.1', 80),
      (err) => err.name === 'ConnectionRefusedError' && codeOf(err) === GATEWAY_ERROR.POLICY_DENIED,
    );
  });

  it('a closed port is refused with CONNECTION_REFUSED', async () => {
    // Find a port nothing listens on.
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    await assert.rejects(
      () => host.backend.connect('127.0.0.1', port),
      (err) => err.name === 'ConnectionRefusedError' && codeOf(err) === GATEWAY_ERROR.CONNECTION_REFUSED,
    );
  });

  it('a name that does not exist fails with DNS_FAILED', async () => {
    await assert.rejects(
      () => host.backend.resolve('nonexistent.invalid'),
      (err) => err.name === 'ConnectionRefusedError' && codeOf(err) === GATEWAY_ERROR.DNS_FAILED,
    );
  });

  it('resolve of a name outside the allow list is refused with POLICY_DENIED', async () => {
    await assert.rejects(
      () => host.backend.resolve('example.com'),
      (err) => codeOf(err) === GATEWAY_ERROR.POLICY_DENIED,
    );
  });

  it('resolve of an allowed literal returns it', async () => {
    assert.deepEqual(await host.backend.resolve('127.0.0.1'), ['127.0.0.1']);
  });

  it('sendDatagram reaches a real UDP socket through the host (UDP is send-only: no replies are read)', async () => {
    const udp = dgram.createSocket('udp4');
    const got = Promise.withResolvers();
    udp.on('message', (m) => got.resolve(new Uint8Array(m)));
    await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve));
    try {
      await host.backend.sendDatagram('127.0.0.1', udp.address().port, text('ping'));
      assert.equal(new TextDecoder().decode(await got.promise), 'ping');
    } finally {
      udp.close();
    }
  });

});

describe('GatewayBackend against a server with a connection cap', { skip }, () => {
  let echo;
  let host;
  before(async () => {
    echo = await startEcho();
    host = await startServerHost({ allow: ['127.0.0.1'], allowPrivate: ['127.0.0.1'], maxConnections: 1 });
  });
  after(async () => {
    await host?.close();
    await echo?.close();
  });

  it('past maxConnections the host refuses with QUEUE_FULL', async () => {
    const first = await host.backend.connect('127.0.0.1', echo.port);
    await assert.rejects(
      () => host.backend.connect('127.0.0.1', echo.port),
      (err) => err.name === 'ConnectionRefusedError' && codeOf(err) === GATEWAY_ERROR.QUEUE_FULL,
    );
    await first.close();
  });
});

describe('GatewayBackend listen against a real wsh server host', { skip }, () => {
  let host;
  // A host of its own: the connection cap counts inbound connections too, and the earlier
  // suite's connections are still being torn down on the host side when this one starts.
  before(async () => {
    host = await startServerHost({
      allow: ['127.0.0.1'],
      allowPrivate: ['127.0.0.1'],
      reverse: { bindAddr: '127.0.0.1', ports: [0] },
    });
  });
  after(async () => { await host?.close(); });

  it('listen binds on the host and an inbound connection reaches accept()', async () => {
    const listener = await host.backend.listen(0);
    assert.ok(listener.localPort > 0);
    const outside = net.connect(listener.localPort, '127.0.0.1');
    outside.on('error', () => {});
    const accepted = await listener.accept();
    outside.write('from outside');
    const got = await readBytes(accepted, 12);
    assert.equal(new TextDecoder().decode(got), 'from outside');
    outside.destroy();
    await accepted.close();
    listener.close();
  });
});

describe('GatewayBackend against a server whose gateway has reverse tunnels off', { skip }, () => {
  let host;
  before(async () => { host = await startServerHost({ allow: ['127.0.0.1'], allowPrivate: ['127.0.0.1'] }); });
  after(async () => { await host?.close(); });

  it('listen is refused and surfaces as a listen failure', async () => {
    await assert.rejects(() => host.backend.listen(0), { code: 'ELISTENFAIL' });
  });
});

describe('GatewayBackend against a real in-memory wsh host', { skip }, () => {
  let host;
  let backend;
  before(async () => {
    const keyPair = await wsh.generateKeyPair();
    host = memory.createMemoryHost({
      auth: { authorizedKeys: [await rawPublic(keyPair)] },
      endpoints: { echo: async ({ readable, writable }) => { await readable.pipeTo(writable).catch(() => {}); } },
    });
    const client = await host.connect({ username: 'tester', keyPair });
    backend = new GatewayBackend({ wshClient: client, operationTimeoutMs: 10_000 });
  });
  after(async () => {
    await backend?.close();
    await host?.close();
  });

  it('a memory host serves named endpoints only: TCP connect is refused with POLICY_DENIED', async () => {
    await assert.rejects(
      () => backend.connect('127.0.0.1', 80),
      (err) => err.name === 'ConnectionRefusedError' && codeOf(err) === GATEWAY_ERROR.POLICY_DENIED,
    );
  });

  it('DNS is refused with POLICY_DENIED', async () => {
    await assert.rejects(
      () => backend.resolve('example.com'),
      (err) => codeOf(err) === GATEWAY_ERROR.POLICY_DENIED,
    );
  });

  it('listen is refused', async () => {
    await assert.rejects(() => backend.listen(0), { code: 'ELISTENFAIL' });
  });

});

// ── Bulk transfers: the host meters gateway data with `gateway-credit` ────────────────────────

const MIB = 1024 * 1024;
const WINDOW = 262_144; // the credit each direction starts with, and netway's default window

/** Byte `i` of the test stream: a counter run through a hash, so a lost, repeated or reordered byte shows. */
const patternByte = (i) => Math.imul(i, 2654435761) >>> 24;

/** The bytes `[start, start + length)` of the test stream. */
function pattern(start, length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = patternByte(start + i);
  return out;
}

/** The index of the first byte of `chunk` (which sits at stream offset `start`) that is wrong, or -1. */
function firstBad(chunk, start) {
  for (let i = 0; i < chunk.length; i++) if (chunk[i] !== patternByte(start + i)) return start + i;
  return -1;
}

/** An origin that sends `total` pattern bytes the moment a client connects (honouring its own backpressure), then ends. */
async function startSource(total) {
  const state = { written: 0 };
  const origin = await startEcho(async (s) => {
    try {
      while (state.written < total) {
        const n = Math.min(48_000, total - state.written);
        const ok = s.write(pattern(state.written, n));
        state.written += n;
        if (!ok) await new Promise((resolve) => { s.once('drain', resolve); s.once('close', resolve); });
        if (s.destroyed) return;
      }
      s.end();
    } catch { /* the client went away */ }
  });
  return Object.assign(origin, { state });
}

/** An origin that checks everything it receives against the pattern; `done` settles when the client half-closes. */
async function startSink() {
  const result = Promise.withResolvers();
  let received = 0;
  let bad = -1;
  const origin = await startEcho((s) => {
    s.on('data', (d) => {
      if (bad < 0) bad = firstBad(d, received);
      received += d.length;
    });
    s.on('end', () => { result.resolve({ received, bad }); s.end(); });
    s.on('close', () => result.resolve({ received, bad, closedEarly: true }));
  });
  return Object.assign(origin, { done: result.promise });
}

/** Read the socket to its end, checking every byte against the pattern. Returns `{ total, bad }`. */
async function drainAndCheck(socket, { onChunk } = {}) {
  let total = 0;
  let bad = -1;
  for (;;) {
    const chunk = await socket.read();
    if (chunk === null) break;
    if (bad < 0) bad = firstBad(chunk, total);
    total += chunk.length;
    if (onChunk) await onChunk(chunk, total);
  }
  return { total, bad };
}

describe('GatewayBackend moves bulk data against a real wsh server host (gateway-credit)', { skip }, () => {
  let host;
  before(async () => {
    host = await startServerHost({ allow: ['127.0.0.1'], allowPrivate: ['127.0.0.1'], maxConnections: 8 });
  });
  after(async () => { await host?.close(); });

  it('the host states gateway-credit, so credit is on for this connection', () => {
    assert.equal(host.client.hasFeature('gateway-credit'), true);
  });

  it('origin to client: 4 MiB arrive, every byte right', { timeout: 30_000 }, async () => {
    const origin = await startSource(4 * MIB);
    try {
      const socket = await host.backend.connect('127.0.0.1', origin.port);
      const { total, bad } = await drainAndCheck(socket);
      assert.equal(bad, -1, `first wrong byte at ${bad}`);
      assert.equal(total, 4 * MIB);
      await socket.close();
    } finally {
      await origin.close();
    }
  });

  it('client to origin: 4 MiB arrive, every byte right, and every write resolves', { timeout: 30_000 }, async () => {
    const sink = await startSink();
    try {
      const socket = await host.backend.connect('127.0.0.1', sink.port);
      let sent = 0;
      while (sent < 4 * MIB) {
        const n = Math.min(100_000, 4 * MIB - sent);
        await socket.write(pattern(sent, n));
        sent += n;
      }
      await socket.end();
      const { received, bad, closedEarly } = await sink.done;
      assert.equal(closedEarly, undefined, 'the origin saw the connection die before the end of the data');
      assert.equal(bad, -1, `first wrong byte at ${bad}`);
      assert.equal(received, 4 * MIB);
      await socket.close();
    } finally {
      await sink.close();
    }
  });

  it('both directions at once through an echo origin: 4 MiB each way, every byte right', { timeout: 30_000 }, async () => {
    const origin = await startEcho((s) => { s.on('error', () => {}); s.pipe(s); });
    try {
      const socket = await host.backend.connect('127.0.0.1', origin.port);
      const reading = drainAndCheck(socket);
      let sent = 0;
      while (sent < 4 * MIB) {
        const n = Math.min(70_000, 4 * MIB - sent);
        await socket.write(pattern(sent, n));
        sent += n;
      }
      await socket.end();
      const { total, bad } = await reading;
      assert.equal(bad, -1, `first wrong byte at ${bad}`);
      assert.equal(total, 4 * MIB);
      await socket.close();
    } finally {
      await origin.close();
    }
  });

  it('a slow reader holds back the origin: bytes received and not yet read stay bounded, and nothing is lost', { timeout: 30_000 }, async (t) => {
    const total = 6 * MIB;
    const origin = await startSource(total);
    // Count what the wire delivers to the backend, outside the consumer's reads.
    const inner = host.client.onGatewayMessage;
    let onWire = 0;
    let readByConsumer = 0;
    let worstUnread = 0;
    const windowFull = Promise.withResolvers();
    host.client.onGatewayMessage = (msg) => {
      if (msg.type === 0x7e) {
        onWire += msg.data.length;
        // The deliberately slow consumer is stalled below, so the backlog grows until something stops the origin.
        worstUnread = Math.max(worstUnread, onWire - readByConsumer);
        if (onWire - readByConsumer >= WINDOW) windowFull.resolve();
      }
      inner(msg);
    };
    try {
      const socket = await host.backend.connect('127.0.0.1', origin.port);
      const gate = Promise.withResolvers();
      const reading = drainAndCheck(socket, {
        onChunk: async (chunk, seen) => {
          readByConsumer = seen;
          if (seen === chunk.length) await gate.promise; // stall after the very first chunk
        },
      });
      await windowFull.promise;
      // The consumer has read one chunk and is stalled. Let the rest of the transfer run ahead, a macrotask turn
      // at a time, until the wire has been quiet for 200 turns or all of it has arrived. (This only gives a
      // backlog room to grow; the bound below is a safety property and holds at any moment.)
      for (let quiet = 0, last = -1; quiet < 200 && onWire < total; quiet = onWire === last ? quiet + 1 : 0) {
        last = onWire;
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.ok(onWire < total, 'everything arrived while the consumer was stalled: nothing held the origin back');
      // What can be in the backend unread: the socket's own window plus the credit the host holds for it.
      assert.ok(worstUnread <= 2 * WINDOW, `unread bytes reached ${worstUnread}, over the bound of ${2 * WINDOW}`);
      assert.ok(socket.readableLength <= WINDOW, `readableLength ${socket.readableLength} is over the window ${WINDOW}`);
      t.diagnostic(`stalled consumer: ${onWire} of ${total} bytes on the wire, ${socket.readableLength} buffered in the socket, worst unread ${worstUnread} (bound ${2 * WINDOW})`);
      gate.resolve();
      const result = await reading;
      assert.equal(result.bad, -1);
      assert.equal(result.total, total);
      assert.ok(worstUnread <= 2 * WINDOW, `unread bytes reached ${worstUnread}, over the bound of ${2 * WINDOW}`);
      await socket.close();
    } finally {
      host.client.onGatewayMessage = inner;
      await origin.close();
    }
  });

  it('a slow origin reader paces the writer: accepted but not yet on the wire stays bounded, and nothing is lost', { timeout: 30_000 }, async (t) => {
    const total = 4 * MIB;
    let received = 0;
    let bad = -1;
    const done = Promise.withResolvers();
    // An origin that takes one chunk per macrotask turn.
    const origin = await startEcho((s) => {
      s.on('error', () => {});
      s.on('data', (d) => {
        if (bad < 0) bad = firstBad(d, received);
        received += d.length;
        s.pause();
        setImmediate(() => s.resume());
      });
      s.on('end', () => done.resolve());
    });
    const innerSend = host.client.sendControl.bind(host.client);
    let onWire = 0;
    host.client.sendControl = (msg) => {
      if (msg.type === 0x7e) onWire += msg.data.length;
      return innerSend(msg);
    };
    try {
      const socket = await host.backend.connect('127.0.0.1', origin.port);
      let accepted = 0;
      let worstUnsent = 0;
      while (accepted < total) {
        const n = Math.min(100_000, total - accepted);
        await socket.write(pattern(accepted, n));
        accepted += n;
        worstUnsent = Math.max(worstUnsent, accepted - onWire);
      }
      await socket.end();
      await done.promise;
      assert.equal(bad, -1, `first wrong byte at ${bad}`);
      assert.equal(received, total);
      // In the socket's window, plus the chunk the pump holds while it waits for credit.
      assert.ok(worstUnsent <= 2 * WINDOW, `${worstUnsent} bytes were accepted but not sent, over the bound of ${2 * WINDOW}`);
      t.diagnostic(`slow origin: ${received} bytes delivered, worst accepted-but-unsent ${worstUnsent} (bound ${2 * WINDOW})`);
      await socket.close();
    } finally {
      delete host.client.sendControl; // back to the prototype's method
      await origin.close();
    }
  });
});
