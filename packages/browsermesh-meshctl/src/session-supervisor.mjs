/**
 * session-supervisor.mjs — adds `getSupervisor()` to a built `MeshctlSession`
 * (issue #185 item 6), shared by `loopback.mjs` and `real-mesh.mjs` so
 * `connect.mjs`'s own `connect()` stays a plain `loopback ? ... : ...`
 * dispatch and every path to a session -- including `test/helpers.mjs`'s
 * `buildLoopbackFixture()`, which calls `createLoopbackSession()` directly,
 * bypassing `connect()` entirely -- gets the same augmentation.
 */

import { createPodSupervisor } from '@johnhenry/browsermesh-apps'

/**
 * Wrap a session so `getSupervisor()` lazily builds (and caches, for the
 * life of the session) a `PodSupervisor` driven over its own
 * `client`/`peerNode`, and `close()` stops that supervisor (clearing its
 * backoff timers) before tearing down the transport it runs over.
 *
 * @param {object} session - A `MeshctlSession` missing `getSupervisor()`.
 * @returns {object} The same session, augmented.
 */
export function withSupervisor(session) {
  /** @type {object|null} */
  let supervisor = null
  const baseClose = session.close
  return {
    ...session,
    async getSupervisor() {
      if (!supervisor) {
        supervisor = createPodSupervisor({ client: session.client, peerNode: session.peerNode })
      }
      return supervisor
    },
    async close() {
      if (supervisor) {
        supervisor.stop()
        supervisor = null
      }
      await baseClose()
    },
  }
}
