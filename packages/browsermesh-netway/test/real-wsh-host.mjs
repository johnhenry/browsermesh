/**
 * A real `createWshServer` host served over an in-memory socket pair, with a connected real client and a
 * GatewayBackend on it. Shared by the tests that need the real host's half-close behaviour (wsh 0.57 and later).
 * Not a test file (the test glob is `test/*.test.mjs`).
 */
import net from 'node:net';
import { GatewayBackend } from '../src/gateway-backend.mjs';

export let wsh = null;
export let memory = null;
export let serverMod = null;
try {
  wsh = await import('@johnhenry/wsh');
  memory = await import('@johnhenry/wsh/memory');
  serverMod = await import('@johnhenry/wsh/server');
} catch { /* the caller skips */ }

export const skip = wsh ? false : '@johnhenry/wsh is not installed';

async function rawPublic(keyPair) {
  return new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
}

/**
 * @param {object} gateway the host's `gateway` options
 * @param {object} [backendOpts] passed to the GatewayBackend
 */
export async function startServerHost(gateway, backendOpts = {}) {
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
  const backend = new GatewayBackend({ wshClient: client, operationTimeoutMs: 10_000, ...backendOpts });
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

/**
 * An origin that keeps its own half open: `onConnection(socket)` sees every accepted socket, which does not end
 * itself when the peer's end of file arrives.
 */
export async function startOrigin(onConnection) {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    onConnection(s);
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

/** Read until the socket ends; resolves with everything read. */
export async function readAll(socket) {
  const parts = [];
  for (;;) {
    const chunk = await socket.read();
    if (chunk === null) break;
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}
