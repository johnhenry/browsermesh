/**
 * wsh-in-process.mjs -- a wsh pipe relay that lives in this process, for tests
 * and examples: no network, no ports.
 *
 * `createInProcessPipeRelay()` returns a `WebSocket` constructor that dials the
 * relay (`new env.WebSocket(pipeUrl)`), so a `WshPeerLinks` takes it as
 * `{ WebSocket: env.WebSocket }` and two pods link in one process through the
 * real pipe relay, the real wsh handshake and the real sealed session.
 *
 * The relay can also misbehave on request, which is how the tests show what a
 * hostile relay cannot do. Every byte it copies is recorded in `env.recorded`
 * (`{ to: 'host'|'operator', id, bytes }`, `to` being the role it was written
 * to), `env.tap` may change, drop, repeat or add to what it writes, and
 * `env.dropAll()` ends every pipe at once.
 *
 * Needs `@johnhenry/wsh` (imported on the call).
 */

/**
 * @param {object} [opts]
 * @param {(info: { to: 'host'|'operator', id: string, bytes: Uint8Array }) => (Uint8Array | Uint8Array[] | null | undefined)} [opts.tap]
 *   Called for every message the relay writes. Return `undefined` to pass it through, `null` to drop it, or one or more
 *   `Uint8Array`s to write instead.
 * @param {object} [opts.relayOptions] - Options for `createPipeRelay()`.
 */
export async function createInProcessPipeRelay({ tap = null, relayOptions } = {}) {
  let pipeRelay;
  let memory;
  try {
    pipeRelay = await import('@johnhenry/wsh/pipe-relay');
    memory = await import('@johnhenry/wsh/memory');
  } catch (cause) {
    throw new Error('createInProcessPipeRelay needs @johnhenry/wsh (npm install @johnhenry/wsh)', { cause });
  }
  const relay = pipeRelay.createPipeRelay(relayOptions);
  const sockets = new Set();
  const env = {
    relay,
    recorded: [],
    tap,
    stats: () => relay.stats(),
    /** End every pipe, as a relay restart would. */
    dropAll() {
      for (const s of [...sockets]) { try { s.close(1012, 'relay restarted'); } catch { /* already closed */ } }
    },
    async close() {
      env.dropAll();
      await relay.close();
    },
    WebSocket: null,
  };

  const toBytes = (data) => (data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength));

  env.WebSocket = class InProcessWebSocket {
    constructor(url) {
      const u = new URL(url);
      const id = u.pathname.split('/').pop();
      const role = u.searchParams.get('role') === 'host' ? 'host' : 'operator';
      const [client, server] = memory.createSocketPair();
      const send = server.send.bind(server);
      server.send = (data) => {
        // A text frame (the paired signal a host half asked for with `?paired=1`) is not wsh bytes: passed on as it is, not recorded.
        if (typeof data === 'string') { send(data); return; }
        const bytes = toBytes(data);
        env.recorded.push({ to: role, id, bytes: bytes.slice() });
        let out = [bytes];
        if (env.tap) {
          const r = env.tap({ to: role, id, bytes });
          if (r === null) out = [];
          else if (r !== undefined) out = Array.isArray(r) ? r : [r];
        }
        for (const b of out) send(b);
      };
      sockets.add(server);
      server.addEventListener('close', () => sockets.delete(server));
      // A relay that predates the signal (wsh before 0.54.1) ignores `notifyPaired`, as it would ignore `?paired=1`.
      void relay.accept(server, { id, role, notifyPaired: role === 'host' && u.searchParams.get('paired') === '1' }).catch(() => {});
      return client;
    }
  };
  return env;
}
