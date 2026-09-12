/**
 * kernel-mesh.mjs -- composition glue: build a Kernel with a real mesh
 * capability backed by a connected PeerNode (Phase 4 of the integration plan).
 *
 * `browsermesh-kernel/src/caps.mjs`'s `buildCaps()` previously set `caps.mesh`
 * to a bare `true` marker -- nothing real backed it. `Kernel` now accepts an
 * optional `mesh` constructor option and, when present, hands a tenant
 * granted `KERNEL_CAP.MESH` a scoped `{ send, onReceive }` view instead of the
 * marker -- every `send`/`onReceive` delivery gated by the mesh provider's
 * `registry.checkAccess(peerId, 'mesh', 'send'|'receive')`, so a tenant can
 * only reach peers the registry has actually authorized, not the raw
 * `PeerNode` API (no `connectToPeer`, `addPeer`, `discover`, etc.).
 *
 * **Architectural call (documented here, not silently picked): the wiring
 * lives in `browsermesh-apps`, not `browsermesh-kernel`.** `Kernel`'s `mesh`
 * option is a duck-typed interface (`{ sendTo, onIncomingData, registry:
 * { checkAccess } }`) -- `browsermesh-kernel` does NOT import this package,
 * or any other `@johnhenry/browsermesh-*` package, to satisfy it (confirmed:
 * `packages/browsermesh-kernel/package.json` still declares zero runtime
 * dependencies). Kernel gaining a real dependency on `browsermesh-apps` would
 * invert the family's layering -- `-kernel` is the innermost primitive
 * package everything else composes on top of; `-apps` already depends on
 * `-core`/`-discovery`/`-transport`/`-sync` as the top-of-stack composition
 * layer (see `mesh-bootstrap.mjs`). So `-apps` gains a new peerDependency on
 * `-kernel` instead, and this module -- not kernel.mjs/caps.mjs -- is where a
 * real `PeerNode` gets handed to a `Kernel` constructor. `PeerNode` already
 * satisfies the duck-typed shape kernel expects (`sendTo(pubKey, data)`,
 * `onIncomingData(cb)`, `.registry.checkAccess(pubKey, resource, action)`)
 * with no adapter code needed -- this module's only real job is making that
 * dependency direction, and the one-import convenience, explicit.
 *
 * No browser-only imports at module level.
 */

import { Kernel } from '@johnhenry/browsermesh-kernel'

/**
 * Construct a Kernel whose MESH capability is backed by a real, connected
 * `PeerNode`. Any tenant created via the returned kernel with
 * `KERNEL_CAP.MESH` granted gets `caps.mesh` as a `{ send, onReceive }` view
 * scoped by `peerNode.registry.checkAccess()` (see `Kernel#meshFor()` in
 * `browsermesh-kernel/src/kernel.mjs` for the enforcement itself).
 *
 * @param {object} [opts]
 * @param {import('./peer-node.mjs').PeerNode} [opts.peerNode] - A real,
 *   booted `PeerNode` (e.g. from `createMeshNode()` in mesh-bootstrap.mjs).
 *   Omit to get a kernel with no real mesh backing -- `caps.mesh` then falls
 *   back to the pre-Phase-4 bare boolean marker, matching a plain
 *   `new Kernel()`.
 * @param {object} [opts.kernelOpts] - Passed through to the Kernel
 *   constructor (`clock`, `rng`, `tracerOpts`, `loggerOpts`, `resourceOpts`).
 * @returns {Kernel}
 */
export function createMeshKernel({ peerNode, kernelOpts = {} } = {}) {
  return new Kernel({ ...kernelOpts, mesh: peerNode || null })
}
