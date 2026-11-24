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
 *   too many connections, listen.
 * - `createMemoryHost` from `@johnhenry/wsh/memory`, whose gateway answers named endpoints
 *   only: every TCP, DNS and listen request is refused.
 *
 * `@johnhenry/wsh` is a dev dependency of this package; without it the file skips.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
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
