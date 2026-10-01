/**
 * connect.mjs — picks `--loopback` or `--signaling` and returns one
 * `MeshctlSession` shape either way, so `commands.mjs` never has to know
 * which mode it's talking to.
 *
 * @typedef {object} MeshctlSession
 * @property {'loopback'|'real'} mode
 * @property {string} podId - `meshctl`'s own podId on this mesh.
 * @property {object} peerNode - The booted `PeerNode`.
 * @property {import('@johnhenry/browsermesh-apps').PodHostClient} client
 * @property {() => string[]} knownHosts - Host pubKeys this session already
 *   knows about without being told (loopback: the hosts it created; real:
 *   always empty -- see `real-mesh.mjs`).
 * @property {(ref: string) => {podId: string, label?: string, lane?: string|null}|null} resolveHost
 *   Resolve a `<host>` CLI argument (a pubKey, or in loopback mode also a
 *   friendly label) to `{podId, ...}`. Returns `null` only in loopback mode
 *   for a ref that matches no known host; in real mode every ref resolves
 *   (it's trusted to be a pubKey) since there is no fixed host list.
 * @property {(hostPubKey: string) => Promise<void>} ensureConnected
 * @property {() => Promise<object>} getSupervisor - Lazily build (and cache,
 *   for the life of this session) a `PodSupervisor`
 *   (`@johnhenry/browsermesh-apps`'s `pod-supervisor.mjs`, issue #185 item
 *   6) driven over this session's own `client`/`peerNode`. `close()` stops
 *   it (clears its backoff timers) automatically.
 * @property {(ref: string) => object|null} [loopbackDriverFor] - LOOPBACK
 *   MODE ONLY: the raw `InMemoryPodHostDriver` behind a known host, for
 *   `meshctl pods crash`'s dev-only demo path. Absent in `mode: 'real'`.
 * @property {() => Promise<void>} close
 */

import { UsageError } from './output.mjs'
import { createLoopbackSession } from './loopback.mjs'
import { createRealMeshSession } from './real-mesh.mjs'

// `getSupervisor()` itself is added by each session builder
// (`loopback.mjs`/`real-mesh.mjs`, via `session-supervisor.mjs`'s
// `withSupervisor()`) rather than here, so every caller of
// `createLoopbackSession()`/`createRealMeshSession()` gets it -- including
// `test/helpers.mjs`'s `buildLoopbackFixture()`, which builds a session
// directly and never goes through `connect()` at all.

/**
 * @param {object} opts
 * @param {object} opts.flags - Parsed global flags (`loopback`, `signaling`, `relay`).
 * @param {import('./identity.mjs').MeshctlIdentity} opts.cliIdentity
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.onLog]
 * @param {Function} [opts.WebSocketCtor] - Injectable `WebSocket`, for tests.
 * @returns {Promise<MeshctlSession>}
 */
export async function connect({ flags, cliIdentity, timeoutMs, onLog, WebSocketCtor } = {}) {
  const loopback = Boolean(flags.loopback)
  const signalingUrl = typeof flags.signaling === 'string' ? flags.signaling : undefined

  if (loopback && signalingUrl) {
    throw new UsageError('--loopback and --signaling are mutually exclusive')
  }
  if (!loopback && !signalingUrl) {
    throw new UsageError('this command needs a connection mode: pass --loopback or --signaling <ws://...>')
  }

  if (loopback) {
    return createLoopbackSession({ cliIdentity, timeoutMs })
  }

  const relayUrl = typeof flags.relay === 'string' ? flags.relay : undefined
  return createRealMeshSession({
    cliIdentity, signalingUrl, relayUrl, timeoutMs, onLog, WebSocketCtor,
  })
}
